import buildUserTable from '../build-user-table.util';

const MOCK_USERS = [{ id: '1', firstName: 'Jan' }] as any;

describe('buildUserTable', () => {
  it('should be defined', () => {
    expect(buildUserTable).toBeDefined();
  });

  it('builds table', () => {
    expect(buildUserTable(MOCK_USERS)).toMatchSnapshot();
  });

  it('should map the rows', () => {
    expect(buildUserTable(MOCK_USERS).rows[0].name).toBe('Jan undefined');
  });
});
