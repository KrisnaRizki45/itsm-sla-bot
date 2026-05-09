require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const axios = require("axios");

// ======================================================
// ENV
// ======================================================

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;

const MONGO_URI =
  process.env.MONGODB_URI || process.env.MONGO_URI;

const MONGO_DB_NAME =
  process.env.MONGODB_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  "itsm_sla_bot";

const WHITELIST_GROUP_IDS = String(
  process.env.BOT_WHITELIST_GROUP_IDS ||
    process.env.GROUP_ID ||
    ""
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const SUPERVISOR_GROUP_IDS = String(
  process.env.BOT_SUPERVISOR_GROUP_IDS ||
    process.env.GROUP_ID ||
    ""
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const PICKUP_LIMIT_MINUTES = Number(
  process.env.SLA_PICKUP_THRESHOLD_MINUTES || 10
);

const RESOLVE_LIMIT_MINUTES = Number(
  process.env.SLA_RESOLVE_THRESHOLD_MINUTES || 30
);

// ======================================================
// VALIDATION
// ======================================================

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN belum diisi");
  process.exit(1);
}

if (!MONGO_URI) {
  console.error("❌ MONGODB_URI belum diisi");
  process.exit(1);
}

// ======================================================
// BOT INIT
// ======================================================

const bot = new Telegraf(BOT_TOKEN);

// ======================================================
// APPLICATION MASTER
// ======================================================

const APP_KEYWORDS = [
  {
    code: "UTO",
    name: "UT Online",
    keywords: [
      "uto",
      "ut online",
      "ut-online",
      "utonline",
      "ebis",
    ],
  },
  {
    code: "MIT",
    name: "MyTech",
    keywords: ["mit", "mytech", "my tech"],
  },
  {
    code: "MIS",
    name: "MyStaff",
    keywords: ["mis", "mystaff", "my staff"],
  },
  {
    code: "IDMT",
    name: "Identify Management",
    keywords: ["idmt", "identify management", "idm"],
  },
  {
    code: "NAD",
    name: "Nadia",
    keywords: ["nad", "nadia"],
  },
];

// ======================================================
// ENGINEER MASTER
// ======================================================

const TEAM_MEMBERS = {
  krd: "Krisna Rizki Dermawan",
  hh: "Heri Hermawan",
  ayb: "Pramuda Asa Ayubi",
  rim: "Raffi Indra Mulya",
  fr: "Fairuz Ridhwan",
  dvd: "David Khalid",
  dc: "Dwi Chandra",
  abs: "Andri Budi Santoso",
  rr: "Rizqi Ramdhan",
};

const TELEGRAM_TO_ENGINEER = {
  krisnard45: "krd",
  herihermawan: "hh",
  pramudaayubi: "ayb",
  raffiindra: "rim",
};

// ======================================================
// AI SYMPTOM RULES
// ======================================================

const symptomRules = [
  {
    keywords: [
      "unlock foto",
      "foto clamp",
      "foto odp",
    ],
    category: "Evidence",
    severity: "medium",
    tags: ["photo", "evidence"],
  },
  {
    keywords: ["reset otp", "otp"],
    category: "OTP",
    severity: "medium",
    tags: ["otp", "auth"],
  },
  {
    keywords: [
      "tidak bisa login",
      "gagal login",
    ],
    category: "Authentication",
    severity: "high",
    tags: ["auth", "login"],
  },
  {
    keywords: [
      "submit gagal",
      "reject",
      "gagal submit",
    ],
    category: "Transaction",
    severity: "high",
    tags: ["transaction", "submit"],
  },
  {
    keywords: ["lambat", "slow"],
    category: "Performance",
    severity: "medium",
    tags: ["performance"],
  },
  {
    keywords: [
      "force close",
      "close aplikasi",
    ],
    category: "Application",
    severity: "medium",
    tags: ["application"],
  },
];

// ======================================================
// REGEX
// ======================================================

const pickupRegex =
  /\b(oncek|oncheck|oncek rekan|otw cek)\b/i;

const resolveRegex =
  /\b(silahkan cek kembali|silakan cek kembali|done|selesai)\b/i;

const solverRegex =
  /\b([A-Z]{2,5})\s*-\s*([a-z0-9]{2,8})\b/i;

// ======================================================
// MONGOOSE SCHEMA
// ======================================================

const ticketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      unique: true,
      index: true,
    },

    app: {
      type: String,
      index: true,
    },

    appName: String,

    symptom: String,
    aiCategory: String,
    aiTags: [String],
    severity: String,

    rawText: String,

    reporterName: String,
    reporterUsername: String,

    groupName: String,

    groupId: {
      type: String,
      index: true,
    },

    groupType: String,

    solverInitial: String,
    solverName: String,
    solverTelegram: String,

    status: {
      type: String,
      enum: [
        "OPEN",
        "PICKED_UP",
        "DONE",
        "DUPLICATE",
      ],
      default: "OPEN",
      index: true,
    },

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    pickupAt: Date,
    resolvedAt: Date,

    responseSLA: Number,
    resolutionSLA: Number,
    handlingMinutes: Number,

    responseSeconds: Number,
    resolutionSeconds: Number,
    handlingSeconds: Number,

    telegramMessageId: Number,
    replyToMessageId: Number,

    alertedPickup: {
      type: Boolean,
      default: false,
    },

    alertedResolve: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

const Ticket =
  mongoose.models.TelegramTicket ||
  mongoose.model(
    "TelegramTicket",
    ticketSchema
  );

// ======================================================
// HELPER
// ======================================================

function detectApp(text = "") {
  const normalized = text.toLowerCase();

  const match = APP_KEYWORDS.find((item) =>
    item.keywords.some((keyword) =>
      normalized.includes(keyword)
    )
  );

  if (!match) {
    return {
      code: "UNKNOWN",
      name: "Unknown Application",
    };
  }

  return {
    code: match.code,
    name: match.name,
  };
}

function classifySymptom(text = "") {
  const normalized = text.toLowerCase();

  const rule = symptomRules.find((item) =>
    item.keywords.some((keyword) =>
      normalized.includes(keyword)
    )
  );

  return {
    symptom: rule
      ? rule.category
      : text.split("\n")[0].slice(0, 120),

    aiCategory: rule
      ? rule.category
      : "General",

    aiTags: rule
      ? rule.tags
      : ["general"],

    severity: rule
      ? rule.severity
      : "medium",
  };
}

function generateTicketId(date = new Date()) {
  const yyyy = date.getFullYear();

  const mm = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const dd = String(
    date.getDate()
  ).padStart(2, "0");

  const hh = String(
    date.getHours()
  ).padStart(2, "0");

  const mi = String(
    date.getMinutes()
  ).padStart(2, "0");

  const ss = String(
    date.getSeconds()
  ).padStart(2, "0");

  return `TKT-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function diffSeconds(start, end) {
  if (!start || !end) return null;

  return Math.max(
    0,
    Math.round(
      (new Date(end).getTime() -
        new Date(start).getTime()) /
        1000
    )
  );
}

function diffMinutes(start, end) {
  if (!start || !end) return null;

  const seconds = diffSeconds(start, end);

  if (seconds === null) return null;

  if (seconds === 0) return 0;

  return Math.max(
    1,
    Math.ceil(seconds / 60)
  );
}

function formatDurationLabel(
  minutes,
  seconds
) {
  if (
    seconds == null &&
    minutes == null
  )
    return "-";

  const safeSeconds = Math.max(
    0,
    Math.round(seconds || 0)
  );

  const mins = Math.floor(
    safeSeconds / 60
  );

  const secs = safeSeconds % 60;

  if (safeSeconds < 60) {
    return `${safeSeconds} detik`;
  }

  if (secs === 0) {
    return `${mins} menit`;
  }

  return `${mins} menit ${secs} detik`;
}

function isWhitelistedGroup(chatId) {
  if (!WHITELIST_GROUP_IDS.length)
    return true;

  return WHITELIST_GROUP_IDS.includes(
    String(chatId)
  );
}

function classifyMessage(text = "") {
  const normalized = text.trim();

  if (
    !normalized ||
    normalized.startsWith("/")
  ) {
    return {
      type: "ignore",
      app: {
        code: "UNKNOWN",
        name: "Unknown",
      },
    };
  }

  const pickup =
    normalized.match(pickupRegex);

  if (pickup) {
    const solver =
      normalized.match(solverRegex);

    return {
      type: "pickup",
      app: detectApp(normalized),
      solverInitial:
        solver?.[2]?.toLowerCase() ||
        null,
    };
  }

  const resolve =
    normalized.match(resolveRegex);

  if (resolve) {
    const solver =
      normalized.match(solverRegex);

    return {
      type: "resolve",
      app: detectApp(normalized),
      solverInitial:
        solver?.[2]?.toLowerCase() ||
        null,
    };
  }

  return {
    type: "report",
    app: detectApp(normalized),
  };
}


// ======================================================
// GOOGLE SHEETS SYNC
// ======================================================

async function syncToGoogleSheets(ticket) {
  try {

    if (!process.env.GOOGLE_SCRIPT_URL)
      return;

    await axios.post(
      process.env.GOOGLE_SCRIPT_URL,
      {
        rows: [
          {
            ticketId: ticket.ticketId,
            status: ticket.status,
            app: ticket.app,
            appName: ticket.appName,
            groupName: ticket.groupName,
            groupId: ticket.groupId,
            symptom: ticket.symptom,
            category: ticket.aiCategory,
            severity: ticket.severity,
            reporterName: ticket.reporterName,
            reporterUsername:
              ticket.reporterUsername,
            solverInitial:
              ticket.solverInitial,
            solverName:
              ticket.solverName,
            solverTelegram:
              ticket.solverTelegram,
            createdAt:
              ticket.createdAt,
            pickupAt:
              ticket.pickupAt,
            resolvedAt:
              ticket.resolvedAt,
            responseSLA:
              ticket.responseSLA,
            resolutionSLA:
              ticket.resolutionSLA,
            handlingMinutes:
              ticket.handlingMinutes,
          },
        ],
      }
    );

    console.log(
      `📊 Sheets Sync ${ticket.ticketId}`
    );

  } catch (error) {

    console.error(
      "❌ Sheets Sync Error:",
      error.message
    );

  }
}


// ======================================================
// MENU
// ======================================================

function mainMenu() {
  return Markup.keyboard([
    ["📊 Report", "🏆 Leaderboard"],
    ["👤 My Stats", "🟠 Open Tickets"],
    ["🔵 Ongoing", "✅ Done Tickets"],
    ["🚨 Late Tickets"],
  ]).resize();
}

// ======================================================
// PROCESS GROUP MESSAGE
// ======================================================

async function processGroupMessage(
  message
) {
  const chat = message.chat || {};

  if (
    !["group", "supergroup"].includes(
      chat.type
    )
  )
    return;

  if (!isWhitelistedGroup(chat.id))
    return;

  const rawText = (
    message.text ||
    message.caption ||
    ""
  ).trim();

  if (!rawText) return;

  const parsed =
    classifyMessage(rawText);

  if (parsed.type === "ignore")
    return;

  // ==================================================
  // CREATE REPORT
  // ==================================================

  if (parsed.type === "report") {
    const ai =
      classifySymptom(rawText);

    const createdAt = new Date(
      (message.date ||
        Math.floor(Date.now() / 1000)) *
        1000
    );

    const created =
      await Ticket.create({
        ticketId:
          generateTicketId(createdAt),

        app: parsed.app.code,
        appName: parsed.app.name,

        symptom: ai.symptom,
        aiCategory: ai.aiCategory,
        aiTags: ai.aiTags,
        severity: ai.severity,

        rawText,

        reporterName: [
          message.from?.first_name,
          message.from?.last_name,
        ]
          .filter(Boolean)
          .join(" "),

        reporterUsername:
          message.from?.username ||
          null,

        groupName:
          chat.title ||
          "Unknown Group",

        groupId: String(chat.id),
        groupType: chat.type,

        status: "OPEN",

        createdAt,

        telegramMessageId:
          message.message_id,

        replyToMessageId:
          message.reply_to_message
            ?.message_id || null,
      });

    console.log(
      `📝 CREATED ${created.ticketId} | ${created.app}`
    );

    await syncToGoogleSheets(created);

    return;
  }

  // ==================================================
  // FIND TICKET
  // ==================================================

  const strictQuery = {
    groupId: String(chat.id),
    status: {
      $in: [
        "OPEN",
        "PICKED_UP",
      ],
    },
  };

  if (
    parsed.app.code !== "UNKNOWN"
  ) {
    strictQuery.app =
      parsed.app.code;
  }

  let ticket =
    await Ticket.findOne(
      strictQuery
    ).sort({
      createdAt: -1,
    });

  if (!ticket) {
    ticket =
      await Ticket.findOne({
        groupId: String(chat.id),
        status: {
          $in: [
            "OPEN",
            "PICKED_UP",
          ],
        },
      }).sort({
        createdAt: -1,
      });
  }

  if (!ticket) return;

  const actionTime = new Date(
    (message.date ||
      Math.floor(Date.now() / 1000)) *
      1000
  );

  // ==================================================
  // PICKUP
  // ==================================================

  if (parsed.type === "pickup") {
    if (
      ticket.status ===
      "PICKED_UP"
    )
      return;

    ticket.status = "PICKED_UP";

    ticket.solverInitial =
      parsed.solverInitial ||
      ticket.solverInitial;

    ticket.solverName =
      TEAM_MEMBERS[
        parsed.solverInitial
      ] || "Unknown Engineer";

    ticket.solverTelegram =
    String(message.from?.username || "")
    .toLowerCase();

    ticket.pickupAt =
      actionTime;

    ticket.responseSeconds =
      diffSeconds(
        ticket.createdAt,
        actionTime
      );

    ticket.responseSLA =
      diffMinutes(
        ticket.createdAt,
        actionTime
      );

    await ticket.save();
    await syncToGoogleSheets(ticket);

    console.log(
      `🟠 PICKUP ${ticket.ticketId}`
    );

    return;
  }

  // ==================================================
  // DONE
  // ==================================================

  if (parsed.type === "resolve") {
    ticket.status = "DONE";

    ticket.solverInitial =
      parsed.solverInitial ||
      ticket.solverInitial;

    ticket.solverName =
      TEAM_MEMBERS[
        parsed.solverInitial
      ] || "Unknown Engineer";

    ticket.solverTelegram =
      message.from?.username ||
      ticket.solverTelegram;

    ticket.resolvedAt =
      actionTime;

    ticket.responseSeconds =
      ticket.responseSeconds ??
      diffSeconds(
        ticket.createdAt,
        ticket.pickupAt ||
          actionTime
      );

    ticket.responseSLA =
      ticket.responseSLA ??
      diffMinutes(
        ticket.createdAt,
        ticket.pickupAt ||
          actionTime
      );

    ticket.resolutionSeconds =
      diffSeconds(
        ticket.createdAt,
        actionTime
      );

    ticket.resolutionSLA =
      diffMinutes(
        ticket.createdAt,
        actionTime
      );

    ticket.handlingSeconds =
      diffSeconds(
        ticket.pickupAt ||
          ticket.createdAt,
        actionTime
      );

    ticket.handlingMinutes =
      diffMinutes(
        ticket.pickupAt ||
          ticket.createdAt,
        actionTime
      );

    await ticket.save();
    await syncToGoogleSheets(ticket);

    console.log(
      `✅ DONE ${ticket.ticketId}`
    );
  }
}

// ======================================================
// REPORT
// ======================================================

async function getReportText(
  period = "today"
) {
  const now = new Date();

  const start = new Date(now);

  if (period === "weekly") {
    const diff =
      (start.getDay() + 6) % 7;

    start.setDate(
      start.getDate() - diff
    );
  } else if (
    period === "monthly"
  ) {
    start.setDate(1);
  }

  start.setHours(0, 0, 0, 0);

  const rows =
    await Ticket.aggregate([
      {
        $match: {
          createdAt: {
            $gte: start,
            $lte: now,
          },
        },
      },
      {
        $group: {
          _id: {
            solverInitial:
              "$solverInitial",
            solverName:
              "$solverName",
          },

          total: {
            $sum: 1,
          },

          resolved: {
            $sum: {
              $cond: [
                {
                  $eq: [
                    "$status",
                    "DONE",
                  ],
                },
                1,
                0,
              ],
            },
          },

          avgResponse: {
            $avg: "$responseSLA",
          },

          avgResponseSeconds: {
            $avg:
              "$responseSeconds",
          },

          avgResolution: {
            $avg:
              "$resolutionSLA",
          },

          avgResolutionSeconds: {
            $avg:
              "$resolutionSeconds",
          },

          tickets: {
            $push: {
              ticketId:
                "$ticketId",
              app: "$app",
              appName:
                "$appName",
              groupName:
                "$groupName",
              status:
                "$status",
            },
          },
        },
      },
      {
        $sort: {
          total: -1,
        },
      },
    ]);

  const open =
    await Ticket.countDocuments({
      status: "OPEN",
    });

  const ongoing =
    await Ticket.countDocuments({
      status: "PICKED_UP",
    });

  const done =
    await Ticket.countDocuments({
      status: "DONE",
    });

  let text = `
📊 REPORT ${period.toUpperCase()}

🗓 Generated : ${now.toLocaleString(
    "id-ID"
  )}

📦 Total Summary
   • OPEN     : ${open}
   • ONGOING  : ${ongoing}
   • DONE     : ${done}

━━━━━━━━━━━━━━━━━━
`;

  rows.forEach((row, index) => {
    const solverInitial =
      row._id.solverInitial ||
      "-";

    const solverName =
      row._id.solverName ||
      "Unassigned";

    const appSummary = {};

row.tickets.forEach((ticket) => {
  const app =
    ticket.app || "UNKNOWN";

  const group =
    ticket.groupName || "Unknown Group";

  if (!appSummary[app]) {
    appSummary[app] = {};
  }

  if (!appSummary[app][group]) {
    appSummary[app][group] = 0;
  }

  appSummary[app][group]++;
});

    text += `
#${index + 1} ${solverInitial}

👨‍💻 Engineer
${solverName}

📦 Summary
• Total Ticket : ${row.total}
• Resolved     : ${row.resolved}

📱 Active Apps
${Object.entries(appSummary)
  .map(([app, groups]) => {
    return `
• ${app}
${Object.entries(groups)
  .map(
    ([group, total]) =>
      `   - ${group} : ${total} tiket`
  )
  .join("\n")}
`;
  })
  .join("\n")}

⏱ SLA Performance
• Response : ${formatDurationLabel(
      Math.round(
        row.avgResponse || 0
      ),
      Math.round(
        row.avgResponseSeconds ||
          0
      )
    )}

• Resolve  : ${formatDurationLabel(
      Math.round(
        row.avgResolution || 0
      ),
      Math.round(
        row.avgResolutionSeconds ||
          0
      )
    )}

━━━━━━━━━━━━━━━━━━
`;
  });

  return text;
}

// ======================================================
// LEADERBOARD
// ======================================================

async function getLeaderboardText() {
  const rows =
    await Ticket.aggregate([
      {
        $match: {
          status: "DONE",
          solverInitial: {
            $ne: null,
          },
        },
      },
      {
        $group: {
          _id: {
            solverInitial:
              "$solverInitial",
            solverName:
              "$solverName",
          },

          total: {
            $sum: 1,
          },

          avgResolve: {
            $avg:
              "$resolutionSeconds",
          },
        },
      },
      {
        $sort: {
          total: -1,
        },
      },
      {
        $limit: 10,
      },
    ]);

  if (!rows.length) {
    return "Belum ada data leaderboard.";
  }

  let text = `
🏆 ENGINEER LEADERBOARD

━━━━━━━━━━━━━━━━━━
`;

  rows.forEach((row, index) => {
    text += `
#${index + 1} ${
      row._id.solverInitial
    }

👨‍💻 ${
      row._id.solverName
    }

📦 Total Done
${row.total} tiket

⚡ Avg Resolve
${formatDurationLabel(
  0,
  Math.round(
    row.avgResolve || 0
  )
)}

━━━━━━━━━━━━━━━━━━
`;
  });

  return text;
}

// ======================================================
// MONITORING
// ======================================================

async function getMonitoringText(type) {
  let query = {};

  if (type === "open") {
    query = { status: "OPEN" };
  }

  if (type === "ongoing") {
    query = { status: "PICKED_UP" };
  }

  if (type === "done") {
    query = { status: "DONE" };
  }

  if (type === "late") {
    query = {
      status: {
        $in: ["OPEN", "PICKED_UP"],
      },
    };
  }

  let rows = await Ticket.find(query)
    .sort({
      createdAt: -1,
    })
    .limit(100);

  // =========================
  // FILTER LATE
  // =========================
  if (type === "late") {
    const now = new Date();

    rows = rows.filter((item) => {
      return diffMinutes(item.createdAt, now) > RESOLVE_LIMIT_MINUTES;
    });
  }

  if (!rows.length) {
    return "Tidak ada tiket.";
  }

  // =========================
  // GROUPING PER APP + GROUP
  // =========================
  const grouped = {};

  rows.forEach((item) => {
    const appKey = `${item.app} - ${item.appName || "Unknown App"}`;
    const groupKey = item.groupName || "Unknown Group";

    if (!grouped[appKey]) {
      grouped[appKey] = {};
    }

    if (!grouped[appKey][groupKey]) {
      grouped[appKey][groupKey] = [];
    }

    grouped[appKey][groupKey].push(item);
  });

  // =========================
  // HEADER
  // =========================
  let text = [];

  const titleMap = {
    open: "🟠 OPEN TICKETS",
    ongoing: "🔵 ONGOING TICKETS",
    done: "✅ DONE TICKETS",
    late: "🚨 LATE TICKETS",
  };

  text.push(titleMap[type] || "🎫 TICKETS");
  text.push("");
  text.push(`🗓 Generated : ${new Date().toLocaleString("id-ID")}`);
  text.push(`📦 Total Ticket : ${rows.length}`);
  text.push("");
  text.push("━━━━━━━━━━━━━━━━━━");
  text.push("");

  // =========================
  // DETAIL
  // =========================
  Object.keys(grouped).forEach((appName) => {
    const appGroups = grouped[appName];

    const totalAppTickets = Object.values(appGroups)
      .reduce((sum, arr) => sum + arr.length, 0);

    text.push(`📱 ${appName}`);
    text.push(`📦 Total Ticket : ${totalAppTickets}`);
    text.push("");

    Object.keys(appGroups).forEach((groupName) => {
      const tickets = appGroups[groupName];

      text.push(`📂 Group : ${groupName}`);
      text.push(`🎫 Total Ticket Group : ${tickets.length}`);
      text.push("");

      tickets.forEach((item, index) => {
        text.push(
          [
            `${index + 1}. ${item.ticketId}`,
            `   👨‍💻 ${
              item.solverInitial || "-"
            } - ${item.solverName || "Unassigned"}`,
            `   📌 ${item.status}`,
            `   🏷 ${item.aiCategory || "General"}`,
            `   ⏱ Response : ${formatDurationLabel(
              item.responseSLA,
              item.responseSeconds
            )}`,
            `   🛠 Resolve : ${formatDurationLabel(
              item.resolutionSLA,
              item.resolutionSeconds
            )}`,
          ].join("\n")
        );

        text.push("");
      });

      text.push("━━━━━━━━━━━━━━━━━━");
      text.push("");
    });
  });

  return text.join("\n");
}

// ======================================================
// USER STATS
// ======================================================

async function getUserStatsText(
  telegramUsername
) {
  const username = String(
    telegramUsername || ""
  )
    .replace("@", "")
    .toLowerCase();

  const engineerCode =
    TELEGRAM_TO_ENGINEER[username];

  if (!engineerCode) {
    return `
❌ Account Telegram belum terdaftar

👤 Username :
@${username}

Hubungi admin untuk mapping engineer.
`;
  }

  const rows = await Ticket.find({
    solverInitial: engineerCode,
    status: "DONE",
  });

  const total = rows.length;

  const avgSeconds = total
    ? Math.round(
        rows.reduce(
          (sum, item) =>
            sum +
            (item.resolutionSeconds || 0),
          0
        ) / total
      )
    : 0;

  const appSummary = {};

  rows.forEach((item) => {
    const key =
      item.appName || item.app || "Unknown";

    appSummary[key] =
      (appSummary[key] || 0) + 1;
  });

  return `
👨‍💻 ${TEAM_MEMBERS[engineerCode]}

🆔 ${engineerCode.toUpperCase()}
👤 @${username}

━━━━━━━━━━━━━━━━━━

📦 Total Done
${total} tiket

⚡ Avg Resolve
${formatDurationLabel(
  0,
  avgSeconds
)}

📱 Apps Handled
${Object.entries(appSummary)
  .map(
    ([app, total]) =>
      `• ${app} : ${total}`
  )
  .join("\n") || "-"}

━━━━━━━━━━━━━━━━━━
`;
}

// ======================================================
// BOT COMMAND
// ======================================================

bot.start(async (ctx) => {
  await ctx.reply(
    `
🚀 SLA TRACKER BOT

Monitoring Ticket Telegram

📌 Available Command

/report
/reportweekly
/reportmonthly
/leaderboard
/open
/ongoing
/done
/late
/cekkrd
`,
    mainMenu()
  );
});

bot.hears(
  "📊 Report",
  async (ctx) =>
    ctx.reply(
      await getReportText("today")
    )
);

bot.hears(
  "🏆 Leaderboard",
  async (ctx) =>
    ctx.reply(
      await getLeaderboardText()
    )
);

bot.hears(
  "👤 My Stats",
  async (ctx) =>
    ctx.reply(
      await getUserStatsText(
        ctx.from?.username ||
          "unknown"
      )
    )
);

bot.hears(
  "🟠 Open Tickets",
  async (ctx) =>
    ctx.reply(
      await getMonitoringText(
        "open"
      )
    )
);

bot.hears(
  "🔵 Ongoing",
  async (ctx) =>
    ctx.reply(
      await getMonitoringText(
        "ongoing"
      )
    )
);

bot.hears(
  "✅ Done Tickets",
  async (ctx) =>
    ctx.reply(
      await getMonitoringText(
        "done"
      )
    )
);

// ======================================================
// COMMAND
// ======================================================

bot.command(
  "report",
  async (ctx) =>
    ctx.reply(
      await getReportText("today")
    )
);

bot.command(
  "reportweekly",
  async (ctx) =>
    ctx.reply(
      await getReportText(
        "weekly"
      )
    )
);

bot.command(
  "reportmonthly",
  async (ctx) =>
    ctx.reply(
      await getReportText(
        "monthly"
      )
    )
);

bot.command(
  "leaderboard",
  async (ctx) =>
    ctx.reply(
      await getLeaderboardText()
    )
);

bot.command(
  "open",
  async (ctx) =>
    ctx.reply(
      await getMonitoringText(
        "open"
      )
    )
);

bot.command(
  "ongoing",
  async (ctx) =>
    ctx.reply(
      await getMonitoringText(
        "ongoing"
      )
    )
);

bot.command(
  "done",
  async (ctx) =>
    ctx.reply(
      await getMonitoringText(
        "done"
      )
    )
);

bot.command(
  "cekkrd",
  async (ctx) =>
    ctx.reply(
      await getUserStatsText(
        "krd"
      )
    )
);

// ======================================================
// LISTENER
// ======================================================

bot.on(
  "message",
  async (ctx, next) => {
    try {
      const text =
        (
          ctx.message?.text ||
          ctx.message?.caption ||
          ""
        ).trim();

      if (
        ctx.message?.chat?.type ===
          "group" ||
        ctx.message?.chat?.type ===
          "supergroup"
      ) {
        console.log(
          `📥 ${ctx.message.chat.title} | ${
            ctx.message.from
              ?.username ||
            "unknown"
          } | ${text}`
        );
      }

      await processGroupMessage(
        ctx.message
      );
    } catch (error) {
      console.error(
        "❌ ERROR:",
        error.message
      );
    }

    return next();
  }
);

// ======================================================
// SLA ALERT
// ======================================================

setInterval(async () => {
  const now = new Date();

  const openTickets =
    await Ticket.find({
      status: "OPEN",
      alertedPickup: false,
    });

  for (const ticket of openTickets) {
    const minutes =
      diffMinutes(
        ticket.createdAt,
        now
      );

    if (
      minutes >
        PICKUP_LIMIT_MINUTES &&
      SUPERVISOR_GROUP_IDS.length
    ) {
      for (const chatId of SUPERVISOR_GROUP_IDS) {
        await bot.telegram.sendMessage(
          chatId,
          `
🚨 SLA PICKUP ALERT

🎫 ${ticket.ticketId}

📱 ${ticket.app} - ${ticket.appName}

📂 ${ticket.aiCategory}

🏢 ${ticket.groupName}

⏱ ${minutes} menit
`
        );
      }

      ticket.alertedPickup = true;

      await ticket.save();
    }
  }
}, 60 * 1000);

// ======================================================
// START
// ======================================================

async function start() {
  try {
    await mongoose.connect(
      MONGO_URI,
      {
        dbName: MONGO_DB_NAME,
        serverSelectionTimeoutMS: 10000,
      }
    );

    console.log(
      "✅ MongoDB Connected"
    );

    const me =
      await bot.telegram.getMe();

    await bot.launch();

    console.log(
      `🤖 Bot Active : @${me.username}`
    );

    console.log(
      "🚀 SLA Tracker Running"
    );
  } catch (error) {
    console.error(
      "❌ Startup Error:",
      error.message
    );

    process.exit(1);
  }
}

start();

process.once("SIGINT", () =>
  bot.stop("SIGINT")
);

process.once("SIGTERM", () =>
  bot.stop("SIGTERM")
);

bot.command("chatid", async (ctx) => {
  await ctx.reply(`CHAT ID: ${ctx.chat.id}`);
});