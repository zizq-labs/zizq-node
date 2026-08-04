// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/** The single queue the uptime_monitor app writes to and drains from. */
export const ZIZQ_QUEUE = "uptime_monitor";

/** Job type names — used on both the enqueue side and in the router. */
export const CHECK_URL = "uptime_monitor.check_url";
export const DISCOVER_SITEMAP_URLS = "uptime_monitor.discover_sitemap_urls";
export const NOTIFY_WEBHOOK = "uptime_monitor.notify_webhook";
export const SCHEDULE_CHECKS = "uptime_monitor.schedule_checks";

/** Cron group name registered on the Zizq server for the periodic sweep. */
export const CRON_GROUP = "uptime_monitor";
