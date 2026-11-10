import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordCoinTransaction } = vi.hoisted(() => ({ recordCoinTransaction: vi.fn() }));
vi.mock("../src/services/coin_service", () => ({ recordCoinTransaction }));

import { processMagicQuestionAnswer } from "../src/services/magic_question_service";

function fakeClient() {
  let answered = false;
  let claimed = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("INSERT INTO magic_question_answers")) {
      if (answered) return { rowCount: 0, rows: [] };
      answered = true;
      return { rowCount: 1, rows: [{ is_correct: true }] };
    }
    if (sql.startsWith("SELECT 1 FROM magic_question_claims"))
      return { rowCount: claimed ? 1 : 0, rows: claimed ? [{}] : [] };
    if (sql.startsWith("SELECT t.amount FROM magic_question_claims"))
      return { rowCount: 1, rows: [{ amount: 250 }] };
    if (sql.startsWith("INSERT INTO magic_question_claims")) {
      claimed = true;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { client: { query } as any, query };
}

const base = { userId: "user-1", questionId: "question-1", levelId: "level-1", optionId: "option-1", rewardCoins: 250 };

describe("Magic Question rewards", () => {
  beforeEach(() => recordCoinTransaction.mockReset().mockResolvedValue({ id: "transaction-1" }));

  it("awards the configured reward once for a correct first answer", async () => {
    const { client } = fakeClient();
    await expect(processMagicQuestionAnswer({ ...base, client, isCorrect: true })).resolves.toEqual({ magicRewardCoins: 250, magicRewarded: true });
    expect(recordCoinTransaction).toHaveBeenCalledOnce();
    expect(recordCoinTransaction).toHaveBeenCalledWith(expect.objectContaining({ userId: base.userId, amount: 250, reference: `magic-question:${base.userId}:${base.questionId}` }), client);
  });

  it("does not award a reward when the first answer was wrong, even if a later answer is correct", async () => {
    const { client } = fakeClient();
    await expect(processMagicQuestionAnswer({ ...base, client, isCorrect: false })).resolves.toEqual({ magicRewardCoins: 0, magicRewarded: false });
    await expect(processMagicQuestionAnswer({ ...base, client, isCorrect: true })).resolves.toEqual({ magicRewardCoins: 0, magicRewarded: false });
    expect(recordCoinTransaction).not.toHaveBeenCalled();
  });

  it("returns an existing claim on retries without paying again", async () => {
    const { client } = fakeClient();
    await processMagicQuestionAnswer({ ...base, client, isCorrect: true });
    await expect(processMagicQuestionAnswer({ ...base, client, isCorrect: true })).resolves.toEqual({ magicRewardCoins: 250, magicRewarded: true });
    expect(recordCoinTransaction).toHaveBeenCalledOnce();
  });
});
