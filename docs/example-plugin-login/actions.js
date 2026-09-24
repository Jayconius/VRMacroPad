module.exports = [
  {
    id: 'example-login.whoami',
    category: 'Example Login (template)',
    label: 'Announce who is signed in',
    description: 'Shows a toast with the signed-in account name. Fails with a clear message if not connected.',
    icon: '👤',
    needs: 'exampleLogin',
    params: [],
    defaults: { label: 'Who am I', icon: '👤', color: '#3a4a6b' },
    async run(params, ctx) {
      const user = await ctx.plugin('example-login').client.whoAmI();
      ctx.toast(`Signed in as ${user.name}`, 'info');
    },
  },
];
