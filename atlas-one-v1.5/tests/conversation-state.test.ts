import { describe, expect, it } from 'vitest';

import { classifyIntent, reduceConversationState } from '../src/conversation/state-engine.js';
import { assessResponse } from '../src/conversation/response-gate.js';
import type { ConversationState, ConversationTurn } from '../src/domain/types.js';

const baseState: ConversationState = {
  conversationId: 'c1',
  status: 'active',
  referencedArtifactIds: [],
  updatedAt: '2026-07-17T00:00:00Z',
};

function turn(id: string, role: ConversationTurn['role'], content: string): ConversationTurn {
  return { id, conversationId: 'c1', role, content, createdAt: `2026-07-17T00:00:0${id}Z`, artifactIds: [] };
}

describe('conversation state engine', () => {
  it('classifies a user correction before generic artifact language', () => {
    expect(classifyIntent("No, that's different than I was hoping for with the folder")).toBe('correction');
  });

  it('records the assistant turn being corrected', () => {
    const withAssistant = reduceConversationState(baseState, turn('1', 'assistant', 'Repeated answer'));
    const corrected = reduceConversationState(withAssistant, turn('2', 'user', 'No, that is not what I meant'));
    expect(corrected.correctionTargetTurnId).toBe('1');
    expect(corrected.unresolvedQuestion).toBe('No, that is not what I meant');
  });

  it('rejects a repeated answer after correction', () => {
    const state: ConversationState = {
      ...baseState,
      correctionTargetTurnId: 'a1',
      unresolvedQuestion: 'I meant a persistent Android workspace folder',
    };
    const assessment = assessResponse(
      'I still have access to my app-private working copy.',
      [turn('1', 'assistant', 'I still have access to my app-private working copy.')],
      state,
    );
    expect(assessment.accepted).toBe(false);
    expect(assessment.reasons).toContain('near_duplicate');
    expect(assessment.reasons).toContain('ignored_correction');
  });
});
