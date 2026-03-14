import { PlanSchema, type Plan, type PlanInput } from '../src/schema.js';

export function makePlan(overrides: Partial<PlanInput> = {}): Plan {
  return PlanSchema.parse({
    id: 'demo',
    title: 'Demo plan',
    prompt: 'Add payments',
    status: 'awaiting_approval',
    nodes: [
      { id: 'api', kind: 'component', label: 'API', changeType: 'modify' },
      { id: 'svc', kind: 'component', label: 'PaymentService', changeType: 'new' },
      {
        id: 'f1',
        kind: 'file',
        label: 'payments.ts',
        path: 'src/payments.ts',
        changeType: 'new',
        parentId: 'svc',
      },
      { id: 'stripe', kind: 'external', label: 'Stripe' },
    ],
    edges: [
      { id: 'e1', from: 'api', to: 'svc' },
      { id: 'e2', from: 'svc', to: 'stripe', label: 'charges' },
    ],
    steps: [
      { id: 's1', order: 1, title: 'Create service', nodeIds: ['svc', 'f1'] },
      { id: 's2', order: 2, title: 'Wire API route', nodeIds: ['api'] },
      { id: 's3', order: 3, title: 'Add webhook', nodeIds: ['stripe'] },
    ],
    ...overrides,
  });
}
