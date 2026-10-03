import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';
import { UserPanelGuard, userPanelStepGuardFactory } from '../user-panel.guard';

const FACADE = { list: jest.fn(() => []) } as unknown as UserPanelFacade;

describe('UserPanelGuard', () => {
  it('returns something', () => {
    const guard = new UserPanelGuard(FACADE as never, FACADE as never, FACADE as never);

    expect(guard.canActivate()).toBeDefined();
  });

  it('should allow step 2', () => {
    expect(userPanelStepGuardFactory('step-2')()).toBe(true);
  });
});
