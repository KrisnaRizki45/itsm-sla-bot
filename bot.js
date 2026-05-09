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

    app: {
      type: String,
      index: true,
    },

    appName: String,

    groupName: String,

    groupId: {
      type: String,
      index: true,
    },

    symptom: String,

    aiCategory: String,

    severity: String,

    reporterName: String,

    reporterUsername: String,

    solverInitial: String,

    solverName: String,

    solverTelegram: String,

    rawText: String,

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
      String(
        message.from?.username || ""
      ).toLowerCase();

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
// COMMAND
// ======================================================

bot.start(async (ctx) => {
  await ctx.reply(
    `
🚀 SLA TRACKER BOT

Monitoring Ticket Telegram
`,
    mainMenu()
  );
});

bot.command("chatid", async (ctx) => {
  await ctx.reply(
    `CHAT ID: ${ctx.chat.id}`
  );
});

bot.command(
  "report",
  async (ctx) => {
    const total =
      await Ticket.countDocuments();

    await ctx.reply(`
📊 REPORT

📦 Total Ticket : ${total}
`);
  }
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
    console.log("🚀 Starting Bot...");

    await mongoose.connect(MONGO_URI, {
      dbName: MONGO_DB_NAME,
      serverSelectionTimeoutMS: 10000,
    });

    console.log("✅ MongoDB Connected");

    console.log("🔍 Checking Telegram bot...");

    const me = await bot.telegram.getMe();

    console.log("✅ Telegram Connected");

    await bot.launch();

    console.log(`🤖 Bot Active : @${me.username}`);
    console.log("🚀 SLA Tracker Running");
  } catch (error) {
    console.error("❌ Startup Error:");
    console.error(error);
    process.exit(1);
  }
}