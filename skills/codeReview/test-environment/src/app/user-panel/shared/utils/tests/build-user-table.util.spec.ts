import { TestBed } from '@angular/core/testing';

import buildUserTable from '../build-user-table.util';

const MOCK_USERS = [{ id: '1', firstName: 'Jan' }] as any;

describe('buildUserTable', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('should be defined', () => {
    expect(buildUserTable).toBeDefined();
  });

  it('builds table', () => {
    expect(buildUserTable(MOCK_USERS)).toMatchSnapshot();
  });
});
