const assert = require('node:assert/strict')
const test = require('node:test')

require('tsx/cjs')

const { decisionItemsFromData, interactiveDecisionRefs } = require('../src/vision-plan/decision-items.ts')

test('decision item contract separates approval and choice controls', () => {
  const items = decisionItemsFromData({
    decisions: [
      { id: 'scope', type: 'approval', question: '确认范围' },
      {
        id: 'runtime',
        type: 'choice',
        question: '选择运行形态',
        recommendedOptionId: 'react',
        options: [
          { id: 'react', label: 'React + Vite' },
          { id: 'static', label: '静态 HTML' },
        ],
      },
    ],
  })

  assert.deepEqual(items, [
    { id: 'scope', question: '确认范围', ref: 'decisions.scope', type: 'approval', options: [], recommendedOptionId: undefined },
    {
      id: 'runtime', question: '选择运行形态', ref: 'decisions.runtime', type: 'choice', recommendedOptionId: 'react',
      options: [
        { id: 'react', label: 'React + Vite', ref: 'decisions.runtime.options.react', recommended: false },
        { id: 'static', label: '静态 HTML', ref: 'decisions.runtime.options.static', recommended: false },
      ],
    },
  ])
  assert.deepEqual([...interactiveDecisionRefs(items)], [
    'decisions.scope',
    'decisions.runtime',
    'decisions.runtime.options.react',
    'decisions.runtime.options.static',
  ])
})

test('decisions with options infer choice type and recommended option', () => {
  assert.deepEqual(decisionItemsFromData({
    decisions: [{ id: 'storage', options: [{ id: 'db', title: 'Database', recommended: true }] }],
  })[0], {
    id: 'storage',
    ref: 'decisions.storage',
    type: 'choice',
    question: undefined,
    recommendedOptionId: 'db',
    options: [{ id: 'db', label: 'Database', ref: 'decisions.storage.options.db', recommended: true }],
  })
})
