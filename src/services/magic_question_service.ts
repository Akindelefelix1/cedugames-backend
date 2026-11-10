import type { PoolClient } from "pg";
import { recordCoinTransaction } from "./coin_service";

type MagicAnswerInput = {
  client: PoolClient;
  userId: string;
  questionId: string;
  levelId: string;
  optionId: string;
  isCorrect: boolean;
  rewardCoins: number;
};

export async function processMagicQuestionAnswer(input: MagicAnswerInput) {
  // The caller must run this helper inside its answer-check transaction so the
  // answer record, coin ledger entry, and claim commit or roll back together.
  const { client, userId, questionId, levelId, optionId, isCorrect, rewardCoins } = input;
  const answer = await client.query(
    "INSERT INTO magic_question_answers(user_id,question_id,option_id,is_correct) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,question_id) DO NOTHING RETURNING is_correct",
    [userId, questionId, optionId, isCorrect],
  );
  const firstAnswer = Boolean(answer.rowCount);
  if (!isCorrect) return { magicRewardCoins: 0, magicRewarded: false };

  const claim = await client.query(
    "SELECT 1 FROM magic_question_claims WHERE user_id=$1 AND question_id=$2",
    [userId, questionId],
  );
  if (claim.rowCount) {
    const reward = await client.query(
      "SELECT t.amount FROM magic_question_claims c JOIN coin_transactions t ON t.id=c.coin_transaction_id WHERE c.user_id=$1 AND c.question_id=$2",
      [userId, questionId],
    );
    const amount = Number(reward.rows[0]?.amount || 0);
    return { magicRewardCoins: amount, magicRewarded: amount > 0 };
  }
  if (!firstAnswer) return { magicRewardCoins: 0, magicRewarded: false };

  const transaction = await recordCoinTransaction({
    userId,
    type: "reward",
    amount: rewardCoins,
    description: "Magic Question reward",
    reference: `magic-question:${userId}:${questionId}`,
    metadata: { kind: "magic_question_reward", questionId, levelId },
  }, client);
  await client.query(
    "INSERT INTO magic_question_claims(user_id,question_id,coin_transaction_id) VALUES($1,$2,$3)",
    [userId, questionId, transaction.id],
  );
  return { magicRewardCoins: Number(rewardCoins), magicRewarded: true };
}
