export const userPanelShellRoutes = [
  {
    path: 'step-1',
    loadComponent: () =>
      import(
        '../components-user-panel/feature/feature-user-panel/feature-user-panel.component'
      ).then((c) => c.UserPanelComponent),
  },
  {
    path: 'step-2',
    loadComponent: () =>
      import(
        '../components-user-panel/feature/feature-user-panel/feature-user-panel.component'
      ).then((c) => c.UserPanelComponent),
  },
];
