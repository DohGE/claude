'use strict';
// eslint-plugin-doh - the code review's own ESLint rules (see references/static.md).
// No dependencies: only what ESLint hands a rule and Node built-ins.
// Template rules walk the Angular template AST of @angular-eslint/template-parser themselves
// (one walk from Program.templateNodes), so they do not depend on the node type names that
// differ between versions (`Element` vs `Element$1`, `Text$3`, ...): a node's kind is its
// `type` (or constructor name) with a `$<n>` suffix dropped.

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- template helpers

const SKIP_KEYS = new Set([
  'parent', 'sourceSpan', 'startSourceSpan', 'endSourceSpan', 'span', 'keySpan', 'valueSpan',
  'nameSpan', 'handlerSpan', 'i18n', 'loc', 'range', 'argumentSpan', 'trackKeywordSpan',
  'mainBlockSpan', 'nameSpan', 'location', 'source', 'errors', 'tokens', 'comments',
]);

function kindOf(n) {
  if (!n || typeof n !== 'object') return '';
  const t = typeof n.type === 'string' ? n.type : (n.constructor && n.constructor.name) || '';
  return t.replace(/\$\d+$/, '');
}

// The AST of an expression, unwrapped from ASTWithSource / parentheses.
function exprOf(v) {
  let e = v;
  while (e && (kindOf(e) === 'ASTWithSource' || kindOf(e) === 'ParenthesizedExpression')) {
    e = kindOf(e) === 'ASTWithSource' ? e.ast : e.expression;
  }
  return e || null;
}

function templateNodes(context) {
  const ast = context.sourceCode.ast;
  return (ast && ast.templateNodes) || [];
}

// Visit every template node (Element, Template, blocks, Text, BoundText, ...) once.
function walkTemplate(nodes, visit) {
  const seen = new Set();
  const go = (n, parents) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach((c) => go(c, parents)); return; }
    visit(n, parents);
    const next = parents.concat([n]);
    for (const key of ['children', 'branches', 'cases', 'empty', 'placeholder', 'loading', 'error']) {
      if (n[key]) go(n[key], next);
    }
  };
  go(nodes, []);
}

// Visit every expression node under an expression AST.
function walkExpr(e, visit) {
  const seen = new Set();
  const go = (n) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(go); return; }
    const k = kindOf(n);
    if (k === 'ASTWithSource') { go(n.ast); return; }
    if (k && k !== 'Object') visit(n);
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = n[key];
      if (v && typeof v === 'object') go(v);
    }
  };
  go(e);
}

function locFromSpan(context, span) {
  const ps = context.sourceCode.parserServices;
  if (ps && typeof ps.convertNodeSourceSpanToLoc === 'function') {
    try { return ps.convertNodeSourceSpanToLoc(span); } catch { /* fall through */ }
  }
  return {
    start: { line: span.start.line + 1, column: span.start.col },
    end: { line: span.end.line + 1, column: span.end.col },
  };
}

// Location of an expression node: its absolute source span (file offsets).
function locFromExpr(context, e, fallbackSpan) {
  const abs = e && e.sourceSpan;
  if (abs && typeof abs.start === 'number' && typeof abs.end === 'number') {
    const sc = context.sourceCode;
    return { start: sc.getLocFromIndex(abs.start), end: sc.getLocFromIndex(abs.end) };
  }
  return locFromSpan(context, fallbackSpan);
}

const BOUND_PROPERTY = 0; // BindingType.Property
const BOUND_ATTRIBUTE = 1; // BindingType.Attribute ([attr.x])
const BOUND_TWO_WAY = 5; // BindingType.TwoWay
const EVENT_TWO_WAY = 2; // ParsedEventType.TwoWay

function origType(n) {
  return typeof n.__originalType === 'number' ? n.__originalType : typeof n.type === 'number' ? n.type : undefined;
}

function isElement(n) {
  return kindOf(n) === 'Element';
}

function elementName(n) {
  return String(n.name || '').replace(/^:[^:]+:/, '').toLowerCase();
}

function textAttr(el, name) {
  return (el.attributes || []).find((a) => a.name === name);
}

function boundInput(el, name, types) {
  return (el.inputs || []).find((i) => i.name === name && (!types || types.includes(origType(i))));
}

function isImplicit(r) {
  const k = kindOf(r);
  return k === 'ImplicitReceiver' || k === 'ThisReceiver';
}

// A call of an implicit-receiver name (`foo(...)`, `this.foo(...)`): returns the name or null.
function implicitCallName(e) {
  const k = kindOf(e);
  if (k !== 'Call' && k !== 'SafeCall') return null;
  const callee = exprOf(e.receiver);
  if (!callee) return null;
  const ck = kindOf(callee);
  if ((ck === 'PropertyRead' || ck === 'SafePropertyRead') && isImplicit(callee.receiver)) return callee.name;
  return null;
}

function templateRule(meta, create) {
  return {
    meta: Object.assign({ type: 'suggestion', schema: [] }, meta),
    create(context) {
      if (!context.sourceCode.ast || !Array.isArray(context.sourceCode.ast.templateNodes)) return {};
      return { Program() { create(context); } };
    },
  };
}

// ---------------------------------------------------------------- template rules

const templateSwitchDefault = templateRule(
  {
    docs: { description: 'Every @switch has an @default (component-template#5)' },
    messages: { noDefault: '@switch without @default - a value no @case covers renders nothing.' },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (kindOf(n) !== 'SwitchBlock') return;
      const hasDefault = (n.cases || []).some((c) => c.expression === null || c.expression === undefined);
      if (!hasDefault) {
        const span = n.startSourceSpan || n.sourceSpan;
        context.report({ loc: locFromSpan(context, span), messageId: 'noDefault' });
      }
    });
  }
);

const templateForTrack = templateRule(
  {
    docs: { description: '@for tracks a stable id, not the item itself nor $index (component-template#3)' },
    messages: {
      trackItem: '@for tracks the item itself (`track {{name}}`, reference identity) - track a stable unique id (`track {{name}}.id`).',
      trackIndex: '@for tracks `$index` - allowed only for a static, never-reordered list.',
    },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (kindOf(n) !== 'ForLoopBlock') return;
      const t = exprOf(n.trackBy);
      if (!t || kindOf(t) !== 'PropertyRead' || !isImplicit(t.receiver)) return;
      const alias = n.item && n.item.name;
      const loc = locFromExpr(context, t, n.startSourceSpan || n.sourceSpan);
      const indexVars = new Set(['$index']);
      for (const v of n.contextVariables || []) if (v && v.value === '$index') indexVars.add(v.name);
      if (t.name === alias) context.report({ loc, messageId: 'trackItem', data: { name: alias } });
      else if (indexVars.has(t.name)) context.report({ loc, messageId: 'trackIndex' });
    });
  }
);

const templateEventSingleCall = templateRule(
  {
    docs: { description: 'An event binding is exactly one call of a component handler (component-template#12)' },
    messages: {
      notSingleCall: 'Event binding `({{event}})` holds template logic ({{what}}) - call ONE component handler and do the rest in the class.',
    },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (!isElement(n) && kindOf(n) !== 'Template') return;
      for (const out of n.outputs || []) {
        if (origType(out) === EVENT_TWO_WAY) continue;
        const e = exprOf(out.handler);
        if (!e) continue;
        let what = null;
        const k = kindOf(e);
        if (k === 'Chain') {
          const exprs = (e.expressions || []).filter(Boolean);
          if (exprs.length === 1) {
            const only = exprOf(exprs[0]);
            what = describeHandler(only);
          } else what = 'several statements';
        } else what = describeHandler(e);
        if (what) {
          context.report({
            loc: locFromSpan(context, out.sourceSpan),
            messageId: 'notSingleCall',
            data: { event: out.name, what },
          });
        }
      }
    });
  }
);

// null when the handler is one call of an implicit-receiver method; else a short description.
function describeHandler(e) {
  const k = kindOf(e);
  if (implicitCallName(e) !== null) return null;
  if (k === 'Call' || k === 'SafeCall') {
    const callee = exprOf(e.receiver);
    const name = callee && callee.name;
    if (name === 'emit') return 'an `.emit(...)`';
    if (name === 'stopPropagation' || name === 'preventDefault') return '`$event.' + name + '()`';
    if (name === 'set' || name === 'update') return 'a signal `.' + name + '(...)`';
    return 'a call of `' + (name || '?') + '` on another object, not a component handler';
  }
  if (/Write$/.test(k) || k === 'Assign' || (k === 'Binary' && e.operation === '=')) return 'an assignment';
  if (k === 'Binary') return 'a `' + e.operation + '` expression';
  if (k === 'Conditional') return 'a ternary';
  return 'no handler call';
}

const FORM_CONTROL_ATTRS = ['formControl', 'formControlName', 'formGroupName'];

const templateDisabledWithFormControl = templateRule(
  {
    docs: { description: 'No [disabled] beside a reactive form control directive (component-template#18)' },
    messages: {
      disabledWithControl: '`[disabled]` bound on an element with `{{directive}}` - disable/enable the control from the class.',
    },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (!isElement(n)) return;
      const disabled = boundInput(n, 'disabled', [BOUND_PROPERTY]);
      if (!disabled) return;
      const directive = FORM_CONTROL_ATTRS.find((a) => textAttr(n, a) || boundInput(n, a));
      if (!directive) return;
      context.report({ loc: locFromSpan(context, disabled.sourceSpan), messageId: 'disabledWithControl', data: { directive } });
    });
  }
);

const templateBlankRel = templateRule(
  {
    docs: { description: 'target="_blank" carries rel="noopener noreferrer" (security#6)' },
    messages: { missingRel: '`target="_blank"` without `rel="noopener noreferrer"`.' },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (!isElement(n)) return;
      const target = textAttr(n, 'target');
      if (!target || String(target.value).trim().toLowerCase() !== '_blank') return;
      if (boundInput(n, 'rel')) return; // bound: cannot know
      const rel = textAttr(n, 'rel');
      const tokens = new Set(String((rel && rel.value) || '').toLowerCase().split(/\s+/));
      if (tokens.has('noopener') && tokens.has('noreferrer')) return;
      context.report({ loc: locFromSpan(context, target.sourceSpan), messageId: 'missingRel' });
    });
  }
);

const HTML_SINKS = new Set(['innerHTML', 'innerhtml', 'outerHTML', 'outerhtml', 'srcdoc']);

// `x | translate`, or a ternary whose every branch is one.
function isTranslated(e) {
  e = exprOf(e);
  if (!e) return false;
  const k = kindOf(e);
  if (k === 'BindingPipe') return e.name === 'translate';
  if (k === 'Conditional') return isTranslated(e.trueExp) && isTranslated(e.falseExp);
  return false;
}

const templateInnerHtml = templateRule(
  {
    docs: { description: '[innerHTML] only for `\'key\' | translate` (security#2, component-template#10)' },
    messages: { untrustedHtml: '`[{{name}}]` bound to something other than a `| translate` value.' },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (!isElement(n) && kindOf(n) !== 'Template') return;
      for (const input of n.inputs || []) {
        if (!HTML_SINKS.has(input.name)) continue;
        const e = exprOf(input.value);
        if (isTranslated(e)) continue;
        context.report({ loc: locFromSpan(context, input.sourceSpan), messageId: 'untrustedHtml', data: { name: input.name } });
      }
    });
  }
);

const TEXT_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'mattooltip']);
const NO_TEXT_PARENTS = new Set(['style', 'script', 'code', 'pre', 'mat-icon']);
const WORD = /\p{L}{2,}/u;
// A dotted identifier path (`page.users.labels.name`) is a translation key the component translates.
const TRANSLATION_KEY = /^[A-Za-z_][\w-]*(?:\.[\w-]+)+$/;

function stripEntities(s) {
  return String(s).replace(/&[a-zA-Z]+;|&#x?[0-9a-fA-F]+;/g, ' ');
}

const templateHardCodedText = templateRule(
  {
    docs: { description: 'No hard-coded user-facing text in a template (i18n#11, component-template#9)' },
    messages: {
      hardCodedText: 'Hard-coded text "{{text}}" - render a translation key through the translate pipe.',
      hardCodedAttr: 'Hard-coded `{{name}}="{{text}}"` - bind a translation key (`[{{name}}]="\'key\' | translate"`).',
    },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n, parents) => {
      const k = kindOf(n);
      if (k === 'Text') {
        const inBlocked = parents.some((p) => {
          if (!isElement(p) && kindOf(p) !== 'Template') return false;
          const name = elementName({ name: p.name || p.tagName });
          return NO_TEXT_PARENTS.has(name) || /-icon$/.test(name);
        });
        if (inBlocked) return;
        const text = stripEntities(n.value);
        if (!WORD.test(text)) return;
        context.report({
          loc: locFromSpan(context, n.sourceSpan),
          messageId: 'hardCodedText',
          data: { text: text.trim().replace(/\s+/g, ' ').slice(0, 60) },
        });
        return;
      }
      if (!isElement(n)) return;
      for (const a of n.attributes || []) {
        if (!TEXT_ATTRS.has(String(a.name).toLowerCase())) continue;
        const text = stripEntities(a.value);
        if (!WORD.test(text) || TRANSLATION_KEY.test(text.trim())) continue;
        context.report({
          loc: locFromSpan(context, a.sourceSpan),
          messageId: 'hardCodedAttr',
          data: { name: a.name, text: text.trim().slice(0, 60) },
        });
      }
    });
  }
);

const DATA_TEST_ELEMENTS = new Set(['button', 'a', 'input', 'select', 'textarea']);

const templateDataTest = templateRule(
  {
    docs: { description: 'Interactive native elements carry data-test (component-template#13)' },
    messages: { missingDataTest: '`<{{name}}>` without `data-test` / `[attr.data-test]`.' },
  },
  (context) => {
    walkTemplate(templateNodes(context), (n) => {
      if (!isElement(n)) return;
      const name = elementName(n);
      if (!DATA_TEST_ELEMENTS.has(name)) return;
      if (name === 'input') {
        const type = textAttr(n, 'type');
        if (type && String(type.value).toLowerCase() === 'hidden') return;
      }
      if (textAttr(n, 'data-test')) return;
      if ((n.inputs || []).some((i) => i.name === 'data-test' || i.name === 'dataTest')) return;
      context.report({ loc: locFromSpan(context, n.startSourceSpan || n.sourceSpan), messageId: 'missingDataTest', data: { name } });
    });
  }
);

// Methods vs fields of the component class read from the sibling .ts (regex over the source,
// comments and string literals blanked). Returns null when the file cannot be read.
const classCache = new Map();
function componentMembers(htmlFile) {
  if (!htmlFile || !/\.html$/i.test(htmlFile)) return null;
  const tsFile = htmlFile.replace(/\.html$/i, '.ts');
  let stat;
  try { stat = fs.statSync(tsFile); } catch { return null; }
  const cached = classCache.get(tsFile);
  if (cached && cached.mtime === stat.mtimeMs) return cached.members;
  let src;
  try { src = fs.readFileSync(tsFile, 'utf8'); } catch { return null; }
  src = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  const methods = new Set();
  const fields = new Set();
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'function', 'return', 'super', 'new', 'get', 'set']);
  const methodRe = /^[ \t]*(?:(?:public|protected|private|static|async|override|readonly)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*[^{};=]+?)?\s*\{/gm;
  let m;
  while ((m = methodRe.exec(src))) {
    if (KEYWORDS.has(m[1])) continue;
    const prefix = src.slice(m.index, m.index + m[0].indexOf(m[1]));
    if (/\b(?:get|set)\s+$/.test(prefix)) { fields.add(m[1]); continue; }
    methods.add(m[1]);
  }
  const fieldRe = /^[ \t]*(?:(?:public|protected|private|static|readonly|override|declare)\s+)*([A-Za-z_$][\w$]*)\s*[!?]?\s*[:=]/gm;
  while ((m = fieldRe.exec(src))) fields.add(m[1]);
  const members = { methods, fields };
  classCache.set(tsFile, { mtime: stat.mtimeMs, members });
  return members;
}

const templateMethodCall = templateRule(
  {
    docs: { description: 'No component method calls in property bindings / interpolations (component-template#11)' },
    messages: {
      methodCall: '`{{name}}()` is a component method called in a binding - expose a computed()/signal or use a pure pipe.',
    },
  },
  (context) => {
    const members = componentMembers(context.filename || (context.getFilename && context.getFilename()));
    if (!members || members.methods.size === 0) return;
    const reported = new Set();
    const check = (value, fallbackSpan) => {
      walkExpr(exprOf(value), (e) => {
        const name = implicitCallName(e);
        if (!name || !members.methods.has(name) || members.fields.has(name)) return;
        const loc = locFromExpr(context, e, fallbackSpan);
        const key = loc.start.line + ':' + loc.start.column;
        if (reported.has(key)) return;
        reported.add(key);
        context.report({ loc, messageId: 'methodCall', data: { name } });
      });
    };
    walkTemplate(templateNodes(context), (n) => {
      const k = kindOf(n);
      if (k === 'BoundText') check(n.value, n.sourceSpan);
      else if (isElement(n) || k === 'Template') {
        for (const i of n.inputs || []) check(i.value, i.sourceSpan);
        for (const a of n.templateAttrs || []) if (a.value && typeof a.value === 'object') check(a.value, a.sourceSpan);
      } else if (k === 'IfBlockBranch' || k === 'SwitchBlock' || k === 'SwitchBlockCase') {
        if (n.expression) check(n.expression, n.startSourceSpan || n.sourceSpan);
      } else if (k === 'ForLoopBlock') {
        check(n.expression, n.startSourceSpan || n.sourceSpan);
        check(n.trackBy, n.startSourceSpan || n.sourceSpan);
      } else if (k === 'LetDeclaration') check(n.value, n.sourceSpan);
    });
  }
);

// ---------------------------------------------------------------- TypeScript helpers

function keyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'PrivateIdentifier') return '#' + node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function calleeName(call) {
  if (!call || call.type !== 'CallExpression') return null;
  let c = call.callee;
  if (c.type === 'TSInstantiationExpression') c = c.expression;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed) {
    const o = c.object.type === 'Identifier' ? c.object.name : null;
    return o ? o + '.' + c.property.name : '.' + c.property.name;
  }
  return null;
}

function unwrapTs(e) {
  while (e && (e.type === 'TSAsExpression' || e.type === 'TSNonNullExpression' || e.type === 'TSSatisfiesExpression')) e = e.expression;
  return e;
}

function isClassField(node) {
  return node.type === 'PropertyDefinition' && !node.computed && !node.declare;
}

function isInjectCall(e) {
  e = unwrapTs(e);
  return calleeName(e) === 'inject';
}

function isFunctionNode(n) {
  return n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
}

function tsRule(meta, create) {
  return { meta: Object.assign({ type: 'suggestion', schema: [] }, meta), create };
}

// ---------------------------------------------------------------- TypeScript rules

const SIGNAL_FACTORIES = new Set([
  'signal', 'computed', 'input', 'input.required', 'output', 'model', 'model.required',
  'viewChild', 'viewChild.required', 'viewChildren', 'contentChild', 'contentChild.required',
  'contentChildren', 'toSignal', 'linkedSignal', 'outputFromObservable',
]);

const readonlySignals = tsRule(
  {
    docs: { description: 'Signal, computed and arrow-function fields are readonly (component#7)' },
    messages: { notReadonly: 'Field `{{name}}` holds {{what}} but is not `readonly`.' },
  },
  (context) => ({
    PropertyDefinition(node) {
      if (!isClassField(node) || node.readonly || !node.value) return;
      const v = unwrapTs(node.value);
      let what = null;
      if (v.type === 'ArrowFunctionExpression') what = 'an arrow function';
      else if (v.type === 'CallExpression') {
        const c = calleeName(v);
        if (c && SIGNAL_FACTORIES.has(c)) what = 'a `' + c + '()` signal';
        else if (c && /\.selectSignal$/.test(c)) what = 'a `selectSignal()` signal';
      }
      if (!what) return;
      context.report({ node: node.key, messageId: 'notReadonly', data: { name: keyName(node.key), what } });
    },
  })
);

const injectPrivateReadonly = tsRule(
  {
    docs: { description: 'Injected fields are `private readonly _camelCase` (component#5)' },
    messages: {
      notPrivateReadonly: 'Injected field `{{name}}` must be `private readonly`.',
      badName: 'Injected field `{{name}}` must be named `_camelCase`.',
    },
  },
  (context) => ({
    PropertyDefinition(node) {
      if (!isClassField(node) || !node.value || !isInjectCall(node.value)) return;
      const name = keyName(node.key);
      if (node.accessibility !== 'private' || !node.readonly || node.key.type === 'PrivateIdentifier') {
        context.report({ node: node.key, messageId: 'notPrivateReadonly', data: { name } });
      }
      if (node.key.type !== 'PrivateIdentifier' && !/^_[a-z][A-Za-z0-9]*$/.test(name || '')) {
        context.report({ node: node.key, messageId: 'badName', data: { name } });
      }
    },
  })
);

const dialogDataPrivate = tsRule(
  {
    docs: { description: 'inject(MAT_DIALOG_DATA) is held in a `private readonly _dialogData` field (feature-component#17)' },
    messages: {
      notPrivate: 'Dialog data `{{name}}` must be held in a `private readonly` field - expose only the named values the template needs.',
      badName: 'Dialog data field `{{name}}` should be named `_dialogData`.',
    },
  },
  (context) => ({
    PropertyDefinition(node) {
      if (!isClassField(node) || !node.value) return;
      const v = unwrapTs(node.value);
      if (calleeName(v) !== 'inject') return;
      const arg = v.arguments[0];
      if (!arg || arg.type !== 'Identifier' || arg.name !== 'MAT_DIALOG_DATA') return;
      const name = keyName(node.key);
      if (node.accessibility !== 'private' || !node.readonly) {
        context.report({ node: node.key, messageId: 'notPrivate', data: { name } });
      } else if (name !== '_dialogData') {
        context.report({ node: node.key, messageId: 'badName', data: { name } });
      }
    },
  })
);

const effectInConstructor = tsRule(
  {
    docs: { description: 'effect() is created only in the constructor (component#12)' },
    messages: {
      effectInField: '`effect()` in a field initializer - create it in the constructor.',
      effectInNgOnInit: '`effect()` in `ngOnInit` - create it in the constructor.',
    },
  },
  (context) => ({
    'CallExpression[callee.type="Identifier"][callee.name="effect"]'(node) {
      let cur = node.parent;
      let crossedFunction = false;
      while (cur) {
        if (cur.type === 'PropertyDefinition' && cur.value) {
          if (!crossedFunction) context.report({ node, messageId: 'effectInField' });
          return;
        }
        if (cur.type === 'MethodDefinition') {
          if (keyName(cur.key) === 'ngOnInit') context.report({ node, messageId: 'effectInNgOnInit' });
          return;
        }
        if (isFunctionNode(cur)) crossedFunction = true;
        cur = cur.parent;
      }
    },
  })
);

function containsDispatch(node) {
  let found = false;
  const seen = new Set();
  const go = (n) => {
    if (found || !n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(go); return; }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'dispatch') { found = true; return; }
    for (const k of Object.keys(n)) if (k !== 'parent' && n[k] && typeof n[k] === 'object') go(n[k]);
  };
  go(node);
  return found;
}

function isThisStoreDispatch(stmt) {
  if (!stmt || stmt.type !== 'ExpressionStatement') return false;
  const e = stmt.expression;
  if (e.type !== 'CallExpression' || e.callee.type !== 'MemberExpression' || e.callee.computed) return false;
  if (e.callee.property.name !== 'dispatch') return false;
  const o = e.callee.object;
  return o.type === 'MemberExpression' && o.object.type === 'ThisExpression';
}

const facadeSingleDispatch = tsRule(
  {
    docs: { description: 'A facade action method is exactly one this._store.dispatch(...) (ngrx-facade#4)' },
    messages: {
      notSingleDispatch: 'Facade method `{{name}}` must be exactly one `this._store.dispatch(...)` statement - no ifs, no multi-dispatch, no transformations.',
    },
  },
  (context) => ({
    MethodDefinition(node) {
      if (node.kind !== 'method' || !node.value || !node.value.body) return;
      const body = node.value.body.body;
      if (!containsDispatch(body)) return;
      // ngrx-facade#6: a method returning a value (Observable via the wait helper) is exempt.
      const rt = node.value.returnType && node.value.returnType.typeAnnotation;
      if (rt && rt.type !== 'TSVoidKeyword') return;
      if (body.some((s) => s.type === 'ReturnStatement' && s.argument)) return;
      if (body.length === 1 && isThisStoreDispatch(body[0])) return;
      context.report({ node: node.key, messageId: 'notSingleDispatch', data: { name: keyName(node.key) } });
    },
  })
);

const facadeSelectSignalName = tsRule(
  {
    docs: { description: 'A selectSignal field is named after its selector without `select` (ngrx-facade#3)' },
    messages: {
      wrongName: 'Signal `{{name}}` selects `{{selector}}` - name it `{{expected}}`.',
    },
  },
  (context) => ({
    PropertyDefinition(node) {
      if (!isClassField(node) || !node.value) return;
      const v = unwrapTs(node.value);
      const c = calleeName(v);
      if (!c || !/\.selectSignal$/.test(c) || v.arguments.length !== 1) return;
      const arg = v.arguments[0];
      const selector = arg.type === 'MemberExpression' && !arg.computed ? arg.property.name : arg.type === 'Identifier' ? arg.name : null;
      if (!selector || !/^select[A-Z]/.test(selector)) return;
      const rest = selector.slice('select'.length);
      const expected = rest.charAt(0).toLowerCase() + rest.slice(1);
      const name = keyName(node.key);
      if (name === expected) return;
      context.report({ node: node.key, messageId: 'wrongName', data: { name, selector, expected } });
    },
  })
);

function actionGroupEvents(node) {
  if (calleeName(node) !== 'createActionGroup') return null;
  const cfg = node.arguments[0];
  if (!cfg || cfg.type !== 'ObjectExpression') return null;
  const ev = cfg.properties.find((p) => p.type === 'Property' && keyName(p.key) === 'events');
  if (!ev || ev.value.type !== 'ObjectExpression') return null;
  return ev.value.properties.filter((p) => p.type === 'Property' && !p.computed);
}

const actionFailProps = tsRule(
  {
    docs: { description: 'Every `* fail` event has props<{ error: HttpErrorResponse }>() (ngrx-actions#4)' },
    messages: {
      failProps: 'Event `{{name}}` must carry `props<{ error: HttpErrorResponse }>()`.',
    },
  },
  (context) => ({
    CallExpression(node) {
      const events = actionGroupEvents(node);
      if (!events) return;
      for (const p of events) {
        const name = keyName(p.key);
        if (!name || !/ fail$/i.test(name)) continue;
        if (failHasHttpError(p.value)) continue;
        context.report({ node: p.key, messageId: 'failProps', data: { name } });
      }
    },
  })
);

function failHasHttpError(v) {
  if (!v || v.type !== 'CallExpression' || calleeName(v) !== 'props') return false;
  const args = v.typeArguments || v.typeParameters;
  const t = args && args.params && args.params[0];
  if (!t || t.type !== 'TSTypeLiteral') return false;
  const err = t.members.find((m) => m.type === 'TSPropertySignature' && keyName(m.key) === 'error');
  const ann = err && err.typeAnnotation && err.typeAnnotation.typeAnnotation;
  return !!(ann && ann.type === 'TSTypeReference' && ann.typeName.type === 'Identifier' && ann.typeName.name === 'HttpErrorResponse' && !err.optional);
}

const actionEventName = tsRule(
  {
    docs: { description: "Event keys are 'Verb subject' sentences with a lower-case success/fail suffix (ngrx-actions#2, #3)" },
    messages: {
      notSentence: "Event key `{{name}}` must be a 'Verb subject' sentence: capital first word, words separated by spaces.",
      suffixCase: 'Event key `{{name}}` must end in lower-case `{{suffix}}` so the generated property is `{{prop}}`.',
    },
  },
  (context) => ({
    CallExpression(node) {
      const events = actionGroupEvents(node);
      if (!events) return;
      for (const p of events) {
        const name = keyName(p.key);
        if (name === null) continue;
        const firstWord = name.split(' ')[0];
        if (!/^[A-Z]/.test(name) || /[_\-.]/.test(firstWord) || /[a-z][A-Z]/.test(firstWord) || /^\s|\s$|\s{2}/.test(name)) {
          context.report({ node: p.key, messageId: 'notSentence', data: { name } });
          continue;
        }
        const m = / (Success|Fail|SUCCESS|FAIL)$/.exec(name);
        if (m) {
          const suffix = m[1].toLowerCase();
          context.report({ node: p.key, messageId: 'suffixCase', data: { name, suffix, prop: 'x' + m[1].charAt(0).toUpperCase() + suffix.slice(1) } });
        }
      }
    },
  })
);

const noExplicitStandalone = tsRule(
  {
    docs: { description: '`standalone: true` is never written (best-practices#3)' },
    messages: { explicitStandalone: '`standalone: true` is the default - drop it.' },
  },
  (context) => ({
    Decorator(node) {
      const e = node.expression;
      if (e.type !== 'CallExpression' || e.callee.type !== 'Identifier' || !['Component', 'Directive', 'Pipe'].includes(e.callee.name)) return;
      const cfg = e.arguments[0];
      if (!cfg || cfg.type !== 'ObjectExpression') return;
      for (const p of cfg.properties) {
        if (p.type === 'Property' && keyName(p.key) === 'standalone' && p.value.type === 'Literal' && p.value.value === true) {
          context.report({ node: p, messageId: 'explicitStandalone' });
        }
      }
    },
  })
);

const storeNotRoot = tsRule(
  {
    docs: { description: "A signalStore is never { providedIn: 'root' } (architecture#3, signal-store#9)" },
    messages: { providedInRoot: "`signalStore({ providedIn: 'root' })` - provide the store in the view that owns it." },
  },
  (context) => ({
    'CallExpression[callee.name="signalStore"]'(node) {
      const cfg = node.arguments[0];
      if (!cfg || cfg.type !== 'ObjectExpression') return;
      for (const p of cfg.properties) {
        if (p.type === 'Property' && keyName(p.key) === 'providedIn' && p.value.type === 'Literal' && p.value.value === 'root') {
          context.report({ node: p, messageId: 'providedInRoot' });
        }
      }
    },
  })
);

// ---------------------------------------------------------------- export

const rules = {
  'template-switch-default': templateSwitchDefault,
  'template-for-track': templateForTrack,
  'template-event-single-call': templateEventSingleCall,
  'template-disabled-with-form-control': templateDisabledWithFormControl,
  'template-blank-rel': templateBlankRel,
  'template-inner-html': templateInnerHtml,
  'template-hard-coded-text': templateHardCodedText,
  'template-data-test': templateDataTest,
  'template-method-call': templateMethodCall,
  'readonly-signals': readonlySignals,
  'inject-private-readonly': injectPrivateReadonly,
  'dialog-data-private': dialogDataPrivate,
  'effect-in-constructor': effectInConstructor,
  'facade-single-dispatch': facadeSingleDispatch,
  'facade-select-signal-name': facadeSelectSignalName,
  'action-fail-props': actionFailProps,
  'action-event-name': actionEventName,
  'no-explicit-standalone': noExplicitStandalone,
  'store-not-root': storeNotRoot,
};

// Recommendation for static/static-map.json: which items each rule settles.
const ruleItems = {
  'template-switch-default': { addresses: ['component-template#5'], level: 'decides', partial: false, note: 'A @switch with no @default case.' },
  'template-for-track': {
    addresses: ['component-template#3'], level: 'points', partial: true,
    messageIds: { trackItem: 'points', trackIndex: 'points' },
    note: '`track item` is a defect only on object collections (primitives are fine) and `track $index` is allowed for static lists - both need judgement, so both point.',
  },
  'template-event-single-call': { addresses: ['component-template#12'], level: 'decides', partial: false, note: 'Handler must be one call of an implicit-receiver name; two-way [(x)] handlers skipped.' },
  'template-disabled-with-form-control': { addresses: ['component-template#18'], level: 'decides', partial: false, note: 'Bound [disabled] (property binding, not [attr.disabled]) beside formControl/formControlName/formGroupName.' },
  'template-blank-rel': { addresses: ['security#6'], level: 'decides', partial: false, note: 'Static target="_blank"; a bound [rel] is not judged.' },
  'template-inner-html': { addresses: ['security#2', 'component-template#10'], level: 'decides', partial: true, note: 'Checks only the sink side; component-template#10 also asks that HTML translations use [innerHTML] instead of interpolation, which needs the translation file (partial there; security#2 can be partial:false).' },
  'template-hard-coded-text': { addresses: ['i18n#11', 'component-template#9'], level: 'points', partial: true, note: 'Brand names, units, symbols and dev-only text are legit hard-coded text; i18n#11 also covers TS code.' },
  'template-data-test': { addresses: ['component-template#13'], level: 'decides', partial: true, note: 'Presence only on native button/a/input/select/textarea; the naming convention and component-selector half stay walked.' },
  'template-method-call': { addresses: ['component-template#11'], level: 'decides', partial: false, note: 'Only implicit-receiver calls of names the sibling .ts declares as methods (regex read); unknown names and a missing .ts report nothing. Also checks @if/@for/@switch/@let expressions. Use points if a false hit shows up.' },
  'readonly-signals': { addresses: ['component#7'], level: 'decides', partial: true, note: 'Enum/const alias fields not checked.' },
  'inject-private-readonly': {
    addresses: ['component#5'], level: 'decides', partial: true,
    messageIds: { notPrivateReadonly: 'decides', badName: 'decides' },
    note: 'All inject() fields incl. token injections (MAT_DIALOG_DATA): component#5 and feature-component#17 agree on private readonly _name. The descriptive-name half stays walked.',
  },
  'dialog-data-private': { addresses: ['feature-component#17'], level: 'decides', partial: true, messageIds: { notPrivate: 'decides', badName: 'decides' }, note: 'Exposing only the named values (not the whole object) stays walked.' },
  'effect-in-constructor': { addresses: ['component#12'], level: 'decides', partial: true, note: 'Only the placement half (field initializer / ngOnInit); the allowed purposes and the constructor contents stay walked.' },
  'facade-single-dispatch': { addresses: ['ngrx-facade#4'], level: 'decides', partial: true, note: 'Methods containing a dispatch, not returning a value (ngrx-facade#6 wait-helper methods return an Observable and are skipped). Verb naming and argument shape stay walked.' },
  'facade-select-signal-name': { addresses: ['ngrx-facade#3'], level: 'decides', partial: true, note: 'Name match only; the "only consumed selectors" half stays walked.' },
  'action-fail-props': { addresses: ['ngrx-actions#4'], level: 'decides', partial: false, note: 'Extra props beside a required `error: HttpErrorResponse` are allowed.' },
  'action-event-name': {
    addresses: ['ngrx-actions#2', 'ngrx-actions#3'], level: 'decides', partial: true,
    messageIds: { notSentence: 'ngrx-actions#2', suffixCase: 'ngrx-actions#3' },
    note: 'notSentence: lower-case start, camelCase/underscored first word. suffixCase: capitalised Success/Fail (the item wants lower-case). The source name and the trio completeness stay walked.',
  },
  'no-explicit-standalone': { addresses: ['best-practices#3'], level: 'decides', partial: true, note: 'The "no new NgModule" half stays walked.' },
  'store-not-root': { addresses: ['signal-store#9', 'architecture#3'], level: 'decides', partial: true, note: 'Only signalStore({ providedIn: root }); facade/effects providedIn and provider placement stay walked.' },
};

module.exports = {
  meta: { name: 'eslint-plugin-doh', version: '1.0.0' },
  rules,
  ruleItems,
};
