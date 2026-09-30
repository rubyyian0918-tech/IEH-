// 驗證指令入口：npm run check -- <項目> [參數]
import { CHECKS } from './checks/registry.js';
import { saveResult, STATUS } from './checks/util.js';

// 不會改動平台資料、可以一次跑完的項目
const READ_ONLY = ['dedupe', 'pages', 'token-health', 'fb-read', 'fb-native-reply', 'fb-ads', 'ig-read', 'ig-ads', 'webhook-stats'];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      args[key] = next && !next.startsWith('--') ? (i++, next) : true;
    } else args._.push(argv[i]);
  }
  return args;
}

function help() {
  console.log('用法：npm run check -- <項目> [參數]\n');
  for (const [id, c] of Object.entries(CHECKS)) {
    console.log(`  ${id.padEnd(16)}${c.title}${c.usage ? `\n  ${''.padEnd(16)}${c.usage}` : ''}`);
  }
  console.log(`\n  ${'all'.padEnd(16)}依序執行所有唯讀項目（${READ_ONLY.join('、')}）`);
}

async function runOne(id, args) {
  const check = CHECKS[id];
  console.log(`\n▶ ${id}：${check.title}`);
  let r;
  try {
    r = await check.run(args);
  } catch (err) {
    r = { status: STATUS.ERROR, summary: err.message, evidence: {} };
  }
  saveResult(id, check.title, r);
  console.log(`  結果：【${r.status}】${r.summary}`);
  return r;
}

const args = parseArgs(process.argv.slice(2));
const target = args._[0];
if (!target || target === 'help') help();
else if (target === 'all') for (const id of READ_ONLY) await runOne(id, args);
else if (CHECKS[target]) await runOne(target, args);
else {
  console.error(`沒有「${target}」這個項目。\n`);
  help();
  process.exitCode = 1;
}
