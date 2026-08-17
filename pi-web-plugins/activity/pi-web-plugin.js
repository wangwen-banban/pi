import {
  activityPanelBadge,
  activityWorkspaceLabelItems,
  defineActivityPanelElement,
  getControllerForContext,
} from './activity-panel.js';

const plugin = {
  apiVersion: 2,
  name: 'Activity',
  activate: ({ runtimePluginId, html, svg }) => {
    defineActivityPanelElement();
    return {
      contributions: {
        actions: [
          {
            id: 'workspace.open-activity',
            title: 'Open Activity',
            description: 'Open live sub-agent and Plan Mode activity for this workspace.',
            group: 'Workspace',
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${runtimePluginId}:workspace.activity`);
            },
          },
        ],
        workspacePanels: [
          {
            id: 'workspace.activity',
            title: 'Activity',
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 12h3l2-6 4 12 2-6h5"></path>
              </svg>
            `,
            order: 35,
            badge: (context) => activityPanelBadge(context),
            onInvalidate: async (context) => {
              await getControllerForContext(context).refreshNow();
            },
            render: (context) => html`<pi-web-activity-panel .context=${context}></pi-web-activity-panel>`,
          },
        ],
        workspaceLabels: [
          {
            id: 'workspace.activity-status',
            order: 35,
            visible: (context) => context.workspace !== undefined,
            items: (context) => activityWorkspaceLabelItems(context),
          },
        ],
      },
    };
  },
};

export default plugin;
