import { Router } from "express";
import { z } from "zod";
import pool from "../config/database_connection";
import { verifyAdminToken, verifyPlayerToken, requireSuperAdmin, type AuthenticatedRequest } from "../middlewares/authentication_middleware";

const router=Router();
const settingsSchema=z.object({isEnabled:z.boolean(),rewardCoins:z.number().int().min(1).max(1000000)});
router.get("/referrals/status",async(_req,res)=>{const r=await pool.query("SELECT is_enabled FROM referral_settings WHERE id=1");res.json({success:true,isEnabled:Boolean(r.rows[0]?.is_enabled)});});
router.get("/referrals/me",verifyPlayerToken,async(req:AuthenticatedRequest,res)=>{
 const accountId=req.user!.accountId||req.user!.id;
 const requestedPage=Number.parseInt(String(req.query.page||"1"),10),requestedLimit=Number.parseInt(String(req.query.limit||"25"),10);
 const page=Number.isFinite(requestedPage)&&requestedPage>0?Math.min(requestedPage,1000000):1,limit=Number.isFinite(requestedLimit)?Math.min(100,Math.max(1,requestedLimit)):25;
 const [owner,rows,summary]=await Promise.all([
  pool.query("SELECT id,referral_code,coins_count,parent_user_id FROM users WHERE id=$1 AND role='user'",[accountId]),
  pool.query(`SELECT r.id,r.status,r.reward_coins,r.created_at,r.qualified_at,u.name referred_name,u.username referred_username
   FROM referrals r JOIN users u ON u.id=r.referred_user_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,[accountId,limit,(page-1)*limit]),
  pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='qualified')::int qualified,COALESCE(SUM(reward_coins) FILTER(WHERE status='qualified'),0)::int coins_earned FROM referrals WHERE referrer_id=$1",[accountId]),
 ]);
 if(!owner.rows[0]||owner.rows[0].parent_user_id)return res.status(404).json({success:false,message:"Referral profile is unavailable for this player."});
 const s=await pool.query("SELECT is_enabled,reward_coins FROM referral_settings WHERE id=1");
 const total=Number(summary.rows[0]?.total||0);
 return res.json({success:true,referralCode:owner.rows[0].referral_code,coinBalance:owner.rows[0].coins_count,settings:s.rows[0]||{is_enabled:false,reward_coins:0},summary:summary.rows[0],referrals:rows.rows,pagination:{page,limit,total,totalPages:Math.ceil(total/limit)}});
});
router.get("/admin/referrals",verifyAdminToken,async(req,res)=>{
 const requestedPage=Number.parseInt(String(req.query.page||"1"),10),requestedLimit=Number.parseInt(String(req.query.limit||"25"),10);
 const page=Number.isFinite(requestedPage)&&requestedPage>0?Math.min(requestedPage,1000000):1,limit=Number.isFinite(requestedLimit)?Math.min(100,Math.max(1,requestedLimit)):25;
 const [settings,summary,items,total]=await Promise.all([
  pool.query("SELECT is_enabled,reward_coins,updated_at FROM referral_settings WHERE id=1"),
  pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='qualified')::int qualified,COUNT(*) FILTER(WHERE status='pending')::int pending,COALESCE(SUM(reward_coins) FILTER(WHERE status='qualified'),0)::bigint coins_awarded FROM referrals"),
  pool.query(`SELECT r.id,r.status,r.reward_coins,r.created_at,r.qualified_at,ref.name referrer_name,ref.email referrer_email,ref.referral_code,referred.name referred_name,referred.email referred_email
   FROM referrals r JOIN users ref ON ref.id=r.referrer_id JOIN users referred ON referred.id=r.referred_user_id
   ORDER BY r.created_at DESC LIMIT $1 OFFSET $2`,[limit,(page-1)*limit]),
  pool.query("SELECT COUNT(*)::int total FROM referrals"),
 ]);
 res.json({success:true,settings:settings.rows[0],summary:summary.rows[0],referrals:items.rows,pagination:{page,limit,total:total.rows[0].total,totalPages:Math.ceil(total.rows[0].total/limit)}});
});
router.put("/admin/referrals/settings",verifyAdminToken,(req,res,next)=>requireSuperAdmin(req as AuthenticatedRequest,res,next),async(req,res)=>{
 const parsed=settingsSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({success:false,errors:parsed.error.issues});
 const {isEnabled,rewardCoins}=parsed.data;
 const result=await pool.query(`INSERT INTO referral_settings(id,is_enabled,reward_coins,updated_at) VALUES(1,$1,$2,NOW())
  ON CONFLICT(id) DO UPDATE SET is_enabled=EXCLUDED.is_enabled,reward_coins=EXCLUDED.reward_coins,updated_at=NOW()
  RETURNING is_enabled,reward_coins,updated_at`,[isEnabled,rewardCoins]);
 res.json({success:true,settings:result.rows[0]});
});
export default router;
