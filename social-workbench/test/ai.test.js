import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSchema, shouldSuggest } from '../src/ai/analyze.js';

test('垃圾訊息與無需回覆不產生回覆建議（控制成本）', () => {
  assert.equal(shouldSuggest({ needs_reply: true, category: '產品詢問' }), true);
  assert.equal(shouldSuggest({ needs_reply: true, category: '垃圾訊息' }), false);
  assert.equal(shouldSuggest({ needs_reply: false, category: '讚美與支持' }), false);
  assert.equal(shouldSuggest(null), false);
});

test('AI 分析結果格式驗證', () => {
  const ok = AnalysisSchema.safeParse({
    category: '客訴', tags: ['衛生'], sentiment: '負面', risk: '高', priority: 'P1',
    needs_reply: true, confidence: 0.9, reason: '食品衛生客訴',
  });
  assert.equal(ok.success, true);
  assert.equal(AnalysisSchema.safeParse({ category: '不存在的分類' }).success, false);
});
