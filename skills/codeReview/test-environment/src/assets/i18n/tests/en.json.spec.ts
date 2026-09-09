import * as en from '../en.json';

describe('en.json', () => {
  it('should match the stored snapshot', () => {
    expect(en).toMatchSnapshot();
  });
});
