import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';
import { UserPanelGuard } from '../user-panel.guard';

const FACADE = { list: jest.fn(() => []) } as unknown as UserPanelFacade;

fdescribe('user panel guard', () => {
  it('returns something', () => {
    const guard = new UserPanelGuard(FACADE as never, FACADE as never, FACADE as never);

    expect(guard.canActivate()).toBeDefined();
  });
});
