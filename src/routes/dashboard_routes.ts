import { Router } from "express";
import pool from "../config/database_connection";
import { verifyAdminToken } from "../middlewares/authentication_middleware";

const router = Router();
const percentageChange = (current: number, previous: number) =>
  !previous ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 1000) / 10;

router.get("/admin/dashboard", verifyAdminToken, async (_req, res) => {
  const [userStats, gameplayStats, purchaseStats, recentTransactions, popularPackages, topPlayers, recentActivities, dailyActivity, gameplayOutcomes, categoryPerformance] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE role='user')::int total,
      COUNT(*) FILTER (WHERE role='user' AND created_at < NOW() - INTERVAL '30 days')::int baseline FROM users`),
    pool.query(`SELECT COUNT(*)::int games_total,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int games_current,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days')::int games_previous,
      COUNT(*) FILTER (WHERE passed)::int levels_total,
      COUNT(*) FILTER (WHERE passed AND created_at >= NOW() - INTERVAL '30 days')::int levels_current,
      COUNT(*) FILTER (WHERE passed AND created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days')::int levels_previous FROM gameplay_attempts`),
    pool.query(`SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status='completed' AND currency='NGN'),0)::bigint total,
      COALESCE(SUM(amount_minor) FILTER (WHERE status='completed' AND currency='NGN' AND completed_at >= NOW() - INTERVAL '30 days'),0)::bigint current,
      COALESCE(SUM(amount_minor) FILTER (WHERE status='completed' AND currency='NGN' AND completed_at >= NOW() - INTERVAL '60 days' AND completed_at < NOW() - INTERVAL '30 days'),0)::bigint previous
      FROM coin_purchase_intents`),
    pool.query(`SELECT t.id,t.type,t.amount,t.created_at,u.name user_name FROM coin_transactions t
      JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 5`),
    pool.query(`SELECT p.id,p.name,p.coins,p.price_minor,p.currency,
      COUNT(i.id) FILTER (WHERE i.status='completed')::int sold FROM coin_packages p
      LEFT JOIN coin_purchase_intents i ON i.package_id=p.id WHERE p.is_active=true GROUP BY p.id
      ORDER BY sold DESC,p.sort_order,p.coins LIMIT 4`),
    pool.query(`SELECT u.id,u.name,u.username,u.total_xp,
      COUNT(DISTINCT a.level_id) FILTER (WHERE a.passed)::int completed_levels,
      COALESCE(MAX(l.level_number) FILTER (WHERE a.passed),0)::int highest_level FROM users u
      LEFT JOIN gameplay_attempts a ON a.user_id=u.id LEFT JOIN game_levels l ON l.id=a.level_id
      WHERE u.role='user' GROUP BY u.id
      HAVING u.total_xp > 0 OR COUNT(a.id) > 0
      ORDER BY u.total_xp DESC,completed_levels DESC,u.created_at ASC LIMIT 4`),
    pool.query(`SELECT id,event_type,title,description,actor_name,metadata,created_at
      FROM activity_logs ORDER BY created_at DESC LIMIT 4`),
    pool.query(`SELECT day::date,
      (SELECT COUNT(*)::int FROM users u WHERE u.role='user' AND u.created_at>=day AND u.created_at<day+INTERVAL '1 day') registrations,
      (SELECT COUNT(*)::int FROM gameplay_attempts a WHERE a.created_at>=day AND a.created_at<day+INTERVAL '1 day') attempts,
      (SELECT COUNT(DISTINCT a.user_id)::int FROM gameplay_attempts a WHERE a.created_at>=day AND a.created_at<day+INTERVAL '1 day') active_players
      FROM generate_series(CURRENT_DATE-INTERVAL '13 days',CURRENT_DATE,INTERVAL '1 day') day ORDER BY day`),
    pool.query(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE passed)::int passed,
      COUNT(*) FILTER(WHERE NOT passed)::int failed,
      COALESCE(ROUND(AVG(score_percent)),0)::int average_score
      FROM gameplay_attempts WHERE created_at>=NOW()-INTERVAL '30 days'`),
    pool.query(`SELECT c.id,c.name,COUNT(a.id)::int attempts,
      COUNT(DISTINCT a.user_id)::int players,
      COALESCE(ROUND(AVG(a.score_percent)),0)::int average_score,
      COALESCE(ROUND(100.0*COUNT(a.id) FILTER(WHERE a.passed)/NULLIF(COUNT(a.id),0)),0)::int pass_rate
      FROM gameplay_attempts a JOIN game_levels l ON l.id=a.level_id
      JOIN game_categories c ON c.id=l.category_id
      WHERE a.created_at>=NOW()-INTERVAL '30 days'
      GROUP BY c.id ORDER BY attempts DESC,c.name LIMIT 5`),
  ]);
  const users=userStats.rows[0], gameplay=gameplayStats.rows[0], purchases=purchaseStats.rows[0];
  const totalUsers=Number(users.total), userBaseline=Number(users.baseline);
  res.json({success:true,stats:{
    totalUsers:{value:totalUsers,change:percentageChange(totalUsers,userBaseline)},
    activeGames:{value:Number(gameplay.games_total),change:percentageChange(Number(gameplay.games_current),Number(gameplay.games_previous))},
    coinsPurchased:{valueMinor:Number(purchases.total),currency:"NGN",change:percentageChange(Number(purchases.current),Number(purchases.previous))},
    levelsCompleted:{value:Number(gameplay.levels_total),change:percentageChange(Number(gameplay.levels_current),Number(gameplay.levels_previous))},
  },recentTransactions:recentTransactions.rows,popularPackages:popularPackages.rows,
  topPlayers:topPlayers.rows.map((player: Record<string, unknown>,index: number)=>({...player,rank:index+1})),recentActivities:recentActivities.rows,
  analytics:{dailyActivity:dailyActivity.rows,gameplayOutcomes:gameplayOutcomes.rows[0],categoryPerformance:categoryPerformance.rows}});
});
export default router;
