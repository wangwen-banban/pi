import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import plugin from './pi-web-plugin.js';

const tag = (strings, ...values) => ({ strings: [...strings], values });

function activate() {
  return plugin.activate({
    apiVersion: 2,
    pluginId: 'activity',
    runtimePluginId: 'local:activity',
    html: tag,
    svg: tag,
  });
}

test('plugin exposes browser API v2 contributions only', () => {
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.name, 'Activity');
  const { contributions } = activate();
  assert.deepEqual(contributions.actions.map((item) => item.id), ['workspace.open-activity']);
  assert.deepEqual(contributions.workspacePanels.map((item) => item.id), ['workspace.activity']);
  assert.deepEqual(contributions.workspaceLabels.map((item) => item.id), ['workspace.activity-status']);
});

test('open action selects the qualified Activity panel only with a workspace', async () => {
  const action = activate().contributions.actions[0];
  const selected = [];
  const withoutWorkspace = { state: {}, selectWorkspaceTool: (id) => selected.push(id) };
  assert.equal(action.enabled(withoutWorkspace), false);
  await action.run(withoutWorkspace);
  assert.deepEqual(selected, []);

  const withWorkspace = {
    state: { selectedWorkspace: { id: 'w1' } },
    selectWorkspaceTool: (id) => selected.push(id),
  };
  assert.equal(action.enabled(withWorkspace), true);
  await action.run(withWorkspace);
  assert.deepEqual(selected, ['local:activity:workspace.activity']);
});

test('panel renders the static custom element and declares badge/invalidation', () => {
  const panel = activate().contributions.workspacePanels[0];
  const context = { marker: true };
  const rendered = panel.render(context);
  assert.match(rendered.strings.join(''), /<pi-web-activity-panel \.context=/);
  assert.match(rendered.strings.join(''), /<\/pi-web-activity-panel>/);
  assert.deepEqual(rendered.values, [context]);
  assert.equal(typeof panel.badge, 'function');
  assert.equal(typeof panel.onInvalidate, 'function');
});

test('workspace label contribution delegates synchronously', () => {
  const label = activate().contributions.workspaceLabels[0];
  assert.equal(typeof label.items, 'function');
  assert.equal(label.visible({ workspace: { id: 'w1' } }), true);
});

test('package metadata is browser-only and points at the entry module', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.piWeb.plugins.length, 1);
  assert.deepEqual(pkg.piWeb.plugins[0], {
    id: 'activity',
    browserRoot: '.',
    module: 'pi-web-plugin.js',
  });
  assert.equal('serverModule' in pkg.piWeb.plugins[0], false);
});

test('entry uses no private server, terminal, REST, or fetch surface', () => {
  const source = readFileSync(new URL('./pi-web-plugin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /serverModule|\.backend|\.terminal|fetch\(|XMLHttpRequest|WebSocket/);
  assert.match(source, /apiVersion:\s*2/);
  assert.match(source, /runtimePluginId}:workspace\.activity/);
});
