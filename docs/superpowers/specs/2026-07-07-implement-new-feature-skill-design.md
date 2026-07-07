# Design: skill `/implementNewFeature` (plugin `implement-new-feature`)

Data: 2026-07-07
Status: zatwierdzony przez użytkownika (brainstorming zakończony)

## Cel

Skill prowadzący użytkownika przez kompletny proces implementacji nowej funkcjonalności w dowolnym projekcie:
zebranie wymagań → refinement → implementacja → walidacja i E2E → code review.
Pipeline zarządza jeden Orchestrator (główna sesja Claude), a każdy etap wykonuje dedykowany sub-agent.
Główny kontekst pozostaje czysty: przechowuje wyłącznie stan procesu, ścieżki artefaktów i krótkie podsumowania.

## Decyzje kluczowe

- UI: pełnoprawna aplikacja steppera w przeglądarce, obsługiwana przez lokalny serwer Node dystrybuowany z pluginem.
- Pakowanie: plugin Claude Code z lokalnym marketplace w tym repo (`D:\WebstormProjects\claude`).
- E2E: zawsze Playwright, niezależnie od istniejącego setupu projektu docelowego.
- Architektura: dedykowany serwer steppera + orchestrator w głównej sesji + sub-agenci raportujący postęp bezpośrednio do serwera.

## Struktura pluginu

```
D:\WebstormProjects\claude\
  .claude-plugin\
    plugin.json                  ← name: "implement-new-feature"
    marketplace.json             ← lokalny marketplace do instalacji
  skills\
    implementNewFeature\
      SKILL.md                   ← instrukcje orchestratora (cały pipeline)
      references\
        refinement-agent.md      ← prompt sub-agenta Kroku 2
        implementation-agent.md  ← prompt sub-agenta Kroku 3
        validation-agent.md      ← prompt sub-agenta Kroku 4
        review-agent.md          ← prompt sub-agenta Kroku 5
      scripts\
        server.cjs               ← serwer steppera (Node, zero zależności)
        ui\index.html            ← aplikacja steppera (vanilla JS, jeden plik)
        start-server.ps1 / .sh   ← start serwera w tle, wybór wolnego portu
```

Instalacja: `claude plugin marketplace add D:\WebstormProjects\claude`, następnie instalacja pluginu `implement-new-feature`.
Pełna nazwa wywołania: `/implement-new-feature:implementNewFeature`; krótkie `/implementNewFeature` dopasowuje się jednoznacznie.

## Serwer steppera

- Node `http`, zero zależności zewnętrznych, bind wyłącznie na `127.0.0.1`, wolny port wybierany automatycznie.
- Uruchamiany w tle na starcie skilla; przeglądarka otwierana automatycznie na `GET /`.
- Stan pipeline'u w pamięci serwera, mirrorowany po każdej zmianie do `pipeline-state.json` w katalogu sesji.
- Katalog sesji: `.implementNewFeature/<timestamp>/` w projekcie docelowym; dopisywany do `.gitignore` projektu.
  Zawiera: `requirements.md`, `mockups/`, `contracts/`, `spec.md`, `plan.md`, `checklist.md`, raporty kroków, `pipeline-state.json`.

### Endpointy

| Endpoint | Kierunek | Rola |
|---|---|---|
| `GET /` | → przeglądarka | UI steppera |
| `GET /api/state` | UI → serwer | polling stanu co ~1 s |
| `POST /api/state` | orchestrator/sub-agenci → serwer | statusy kroków, progress %, opis bieżącej operacji, log zdarzeń |
| `POST /api/answer` | UI → serwer | submit Kroku 1, odpowiedzi Kroku 2, decyzje (Approve / Retry / Zakończ) |
| `GET /api/answer` | orchestrator → serwer | odbiór odpowiedzi użytkownika przez polling |
| `POST /api/upload` | UI → serwer | makiety i kontrakty, zapis do katalogu sesji |

## UI steppera

- Pasek 5 kroków, każdy z nazwą i statusem: Waiting / In Progress / Completed / Failed.
- Panel treści zależny od kroku:
  - Krok 1: formularz — opis zadania (wymagany), wymagania biznesowe (wymagane), upload makiet (opcjonalny), upload lub wklejenie kontraktów API (opcjonalne); przycisk „Dalej" aktywny dopiero po wypełnieniu pól wymaganych.
  - Krok 2: widok Q&A — pytanie agenta plus odpowiedź tekstowa lub opcje do kliknięcia; na końcu podsumowanie spec + planu z przyciskiem **Approve**.
  - Kroki 3–5: progress bar %, nazwa bieżącej operacji, log ostatnich zdarzeń.
  - Po Kroku 5: ekran podsumowania.
- Etykiety kroków po angielsku (Requirements, Feature Refinement, Implementation, Validation & E2E, Code Review); treści dynamiczne w języku rozmowy użytkownika.

## Orchestrator i protokół sub-agentów

Orchestrator to główna sesja Claude wykonująca SKILL.md.
Trzyma wyłącznie: statusy kroków, ścieżki artefaktów, krótkie podsumowania sub-agentów.
Pełne dokumenty żyją na dysku w katalogu sesji; sub-agenci czytają je z plików, więc treści nie przepływają przez główny kontekst.

Kontrakt komunikacyjny: każdy sub-agent kończy turę wiadomością JSON:

```json
{ "type": "question" | "result" | "error", ... }
```

Orchestrator parsuje ostatnią wiadomość i reaguje.
Postęp w trakcie pracy sub-agenci raportują bezpośrednio do serwera (`POST /api/state` przez curl), z pominięciem głównego kontekstu.
Sub-agenci są uruchamiani przez Agent tool (typ general-purpose) z promptem z `references/` + ścieżkami artefaktów; kontynuacja rozmowy z sub-agentem przez SendMessage (kontekst sub-agenta zachowany).

## Przepływ kroków

### Krok 1 — Requirements (interaktywny)

Orchestrator ustawia krok na In Progress i polluje `GET /api/answer` aż przyjdzie submit formularza.
Walidacja pól wymaganych po stronie UI.
Dane trafiają do `requirements.md`, uploady do `mockups/` i `contracts/`.

### Krok 2 — Feature Refinement (interaktywny, proxy Q&A)

Sub-agent refinementu używa wewnętrznie `superpowers:brainstorming`.
Pętla proxy (sub-agenci nie mogą pytać użytkownika bezpośrednio):

1. sub-agent zwraca `{type:"question", text, options?}` i kończy turę,
2. orchestrator wyświetla pytanie w stepperze i polluje odpowiedź,
3. odpowiedź wraca do sub-agenta przez SendMessage,
4. pętla trwa aż agent osiągnie ≥95% pewności, że wymagania są kompletne, i zwróci `{type:"result"}`.

Po refinemencie ten sam sub-agent tworzy plan implementacji skillem `superpowers:writing-plans`.
Zwraca `spec.md`, `plan.md` oraz podsumowanie (~10 zdań) do orchestratora.
Gate: stepper pokazuje podsumowanie z przyciskiem **Approve** — dopiero kliknięcie uruchamia Krok 3; to ostatni planowy moment interakcji (nie licząc decyzji Retry/Zakończ przy statusie Failed).

### Krok 3 — Implementation (poglądowy)

Przed startem orchestrator tworzy branch `feature/<slug>` od bieżącego (slug generowany z tytułu funkcjonalności podanego w Kroku 1).
Sub-agent dostaje ścieżkę `plan.md` i wykonuje plan zadanie po zadaniu w pełni autonomicznie (podejście `superpowers:executing-plans` w wariancie subagent-driven, z TDD; checkpointy ludzkie zastąpione raportami do serwera).
Po każdym zadaniu: `POST /api/state` z `% = ukończone/wszystkie` i nazwą bieżącego zadania.
Zwraca listę zmienionych plików + podsumowanie.

### Krok 4 — Validation & E2E (poglądowy)

Sub-agent walidacyjny:

1. instaluje/konfiguruje Playwright (zawsze Playwright), pisze komplet testów E2E na podstawie `spec.md`,
2. uruchamia testy → naprawia znalezione błędy → uruchamia ponownie,
3. jeśli dostarczono makiety: uruchamia aplikację, robi screenshoty Playwright, porównuje wizualnie z makietami, poprawia UI, powtarza porównanie.

Operacjonalizacja „99% zgodności": ze `spec.md` powstaje `checklist.md`; zgodność = odsetek pozycji potwierdzonych przechodzącym testem lub weryfikacją wizualną.
Pętla kończy się przy ≥99% albo po 3 pełnych cyklach → wtedy status Failed + raport braków.
Progress = odsetek checklisty potwierdzony.

### Krok 5 — Code Review (poglądowy)

Sub-agent stage'uje zmiany (`git add -A`) i uruchamia skill `code-review` na staged diff w trybie z auto-fixem (analiza: błędy, architektura, wydajność, czytelność, regresje).
Po zastosowaniu poprawek sub-agent ponownie uruchamia testy E2E z Kroku 4 (ochrona przed regresją wprowadzoną przez fixy), a następnie wykonuje re-review.
Koniec przy zeru findings i ≥99% zgodności z checklistą; max 3 cykle → inaczej Failed + raport.

### Podsumowanie końcowe

Ekran w UI oraz to samo w terminalu: wykonane zmiany, lista zaimplementowanych funkcjonalności, wyniki testów, wynik porównania z makietami (jeśli były), wyniki code review, końcowy status procesu.

## Git

- Branch `feature/<slug>` tworzony przed Krokiem 3; cała praca na nim, w bieżącym working tree (bez worktree — E2E i dev-server muszą działać w tym samym miejscu).
- Pipeline nie commituje; na końcu zmiany zostają zestage'owane, a podsumowanie sugeruje `superpowers:finishing-a-development-branch`.

## Obsługa błędów

- Krok w statusie Failed zatrzymuje pipeline; stepper pokazuje raport oraz przyciski **Retry step** / **Zakończ**.
- Limity pętli (3 cykle w Krokach 4 i 5) chronią przed pętlą nieskończoną.
- Stan i artefakty są na dysku; formalnego `resume` po restarcie sesji nie ma w v1.
- Jeśli serwer padnie, orchestrator wykrywa to przy najbliższym request i restartuje go z `pipeline-state.json`.

## Mapowanie nazw skilli ze spec wejściowej

| Spec wejściowa | Rzeczywisty skill |
|---|---|
| `/superpowers:brainstorm` | `superpowers:brainstorming` |
| `/superpowers:execute-plan` | `superpowers:executing-plans` (wariant subagent-driven) |
| `/codeReview staged` | `code-review` na staged diff |

Dodatkowo Krok 2 kończy się `superpowers:writing-plans` (spec wymaga kompletnego planu po refinemencie).

## Testowanie pluginu

- Serwer: testy `node:test` dla endpointów i persystencji stanu (bez zależności zewnętrznych).
- Całość: smoke test na przykładowym projekcie webowym — przejście pipeline'u end-to-end z prostą funkcjonalnością.

## Poza zakresem v1

- Formalne wznawianie przerwanej sesji (`resume`).
- Równoległe sesje pipeline'u w jednym projekcie.
- Obsługa projektów innych niż webowe w Kroku 4 (porównanie makiet i Playwright zakładają aplikację webową).
