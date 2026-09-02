//This combines all the route modules
import aunthentication_routes from "./authentication_routes"
import catalogRoutes from "./catalog_routes";
import publicCatalogRoutes from "./public_catalog_routes";
import questionRoutes from "./question_routes";
import coinRoutes from "./coin_routes";
import gameplayRoutes from "./gameplay_routes";
import leaderboardRoutes from "./leaderboard_routes";
import dashboardRoutes from "./dashboard_routes";
import badgeRoutes from "./badge_routes";
import notificationRoutes from "./notification_routes";
import dailyCheckinRoutes from "./daily_checkin_routes";
import mediaRoutes from "./media_routes";
import {Router} from 'express';

const router = Router();

router.use("/auth", aunthentication_routes);
router.use("/admin/catalog", catalogRoutes);
router.use("/catalog", publicCatalogRoutes);
router.use(questionRoutes);
router.use(coinRoutes);
router.use(gameplayRoutes);
router.use(leaderboardRoutes);
router.use(dashboardRoutes);
router.use(badgeRoutes);
router.use(notificationRoutes);
router.use(dailyCheckinRoutes);
router.use(mediaRoutes);

export default router;
