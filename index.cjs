/* index.cjs */
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const https = require('https');
const fs = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { spawn } = require('child_process');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || (FFMPEG.includes('ffmpeg') ? FFMPEG.replace('ffmpeg','ffprobe') : 'ffprobe');

if (!BOT_TOKEN) { console.error('BOT_TOKEN مفقود'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ---- جلسة المستخدم الافتراضية ----
function defaults() {
  return {
    settings: { mode: 'AUTO', upscale: 2, crf: 18, preset: 'veryfast' },
    settingsMsgId: null, settingsChatId: null,
    lastFileId: null      // لإعادة المعالجة
  };
}
function useSession(ctx){
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.settings) ctx.session = defaults();
  return ctx.session;
}

const modeName = {AUTO:'Auto', CLEAN:'Clean+', STAB:'Stabilize', COLOR:'ColorBoost'};
function settingsText(s){
  return `الإعدادات الحالية:\n• الوضع: ${modeName[s.mode]}\n• التكبير: ${s.upscale}x\n• CRF: ${s.crf}\n• السرعة: ${s.preset}`;
}
function settingsKeyboard(s){
  return Markup.inlineKeyboard([
    [ Markup.button.callback(`Mode: ${modeName[s.mode]}`, 'noop'),
      Markup.button.callback('Auto','mode:AUTO'),
      Markup.button.callback('Clean+','mode:CLEAN'),
      Markup.button.callback('Stabilize','mode:STAB'),
      Markup.button.callback('Color','mode:COLOR') ],
    [ Markup.button.callback(`Upscale: ${s.upscale}x`, 'noop'),
      Markup.button.callback('1x','up:1'),
      Markup.button.callback('1.5x','up:1.5'),
      Markup.button.callback('2x','up:2'),
      Markup.button.callback('4x','up:4') ],
    [ Markup.button.callback(`CRF: ${s.crf}`, 'noop'),
      Markup.button.callback('14','crf:14'),
      Markup.button.callback('16','crf:16'),
      Markup.button.callback('18','crf:18'),
      Markup.button.callback('20','crf:20') ],
    [ Markup.button.callback(`Preset: ${s.preset}`, 'noop'),
      Markup.button.callback('ultrafast','pre:ultrafast'),
      Markup.button.callback('veryfast','pre:veryfast'),
      Markup.button.callback('slow','pre:slow') ]
  ], { columns: 5 });
}

// تحديث/إظهار إعدادات بدون تكرار رسائل
async function renderSettings(ctx){
  const ses = useSession(ctx);
  const s = ses.settings;
  try {
    if (ses.settingsMsgId && ses.settingsChatId) {
      await ctx.telegram.editMessageText(
        ses.settingsChatId, ses.settingsMsgId, undefined,
        settingsText(s), settingsKeyboard(s)
      );
    } else {
      const m = await ctx.reply(settingsText(s), settingsKeyboard(s));
      ses.settingsMsgId = m.message_id;
      ses.settingsChatId = m.chat.id;
    }
  } catch {
    const m = await ctx.reply(settingsText(s), settingsKeyboard(s));
    ses.settingsMsgId = m.message_id;
    ses.settingsChatId = m.chat.id;
  }
}

bot.start(async (ctx)=>{
  useSession(ctx);
  await ctx.reply('حيّاك! اختر إعداداتك ثم أرسل الفيديو كـ "ملف" (Document) لنتيجة أفضل 👇');
  await renderSettings(ctx);
});
bot.command('settings', async (ctx)=> renderSettings(ctx));
bot.command('clear', async (ctx)=>{ // يمسح رسالة الإعدادات لو بغيت
  const ses = useSession(ctx);
  if (ses.settingsMsgId) { try{ await ctx.deleteMessage(ses.settingsMsgId);}catch{} }
  ses.settingsMsgId = null; ses.settingsChatId = null;
  await renderSettings(ctx);
});

// أزرار لوحة الإعدادات
bot.action(/^(mode|up|crf|pre):(.+)$/, async (ctx)=>{
  const ses = useSession(ctx);
  const [key,val] = ctx.match.slice(1);
  if (key==='mode') ses.settings.mode = val;
  if (key==='up') ses.settings.upscale = parseFloat(val);
  if (key==='crf') ses.settings.crf = parseInt(val,10);
  if (key==='pre') ses.settings.preset = val;
  try{ await ctx.answerCbQuery('تم التحديث'); }catch{}
  await renderSettings(ctx);
});
bot.action('noop', (ctx)=> ctx.answerCbQuery('اختر من الأزرار الجانبية'));

// زر إعادة المعالجة
bot.action('reprocess', async (ctx)=>{
  const ses = useSession(ctx);
  if (!ses.lastFileId) return ctx.answerCbQuery('مافي ملف سابق', {show_alert:true});
  try{ await ctx.answerCbQuery('يعاد المعالجة…'); }catch{}
  await processByFileId(ctx, ses.lastFileId);
});

// استقبال فيديو/ملف فيديو
bot.on(['video','document'], async (ctx)=>{
  const ses = useSession(ctx);
  const file = ctx.message.video || ctx.message.document;
  if (!file) return;
  if (ctx.message.document && !(ctx.message.document.mime_type || '').startsWith('video/'))
    return ctx.reply('أرسل ملف فيديو لو سمحت.');

  ses.lastFileId = file.file_id;      // احتفظ به لإعادة المعالجة
  await processByFileId(ctx, file.file_id);
});

async function processByFileId(ctx, fileId){
  const ses = useSession(ctx);
  const s = ses.settings;
  const wait = await ctx.reply('يعالج... ✋');

  const inPath  = join(tmpdir(), `in-${Date.now()}.mp4`);
  const outPath = join(tmpdir(), `out-${Date.now()}.mp4`);

  try{
    const fi  = await ctx.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fi.file_path}`;
    await download(url, inPath);

    // معلومات قبل
    const before = await probe(inPath).catch(()=>({}));

    const vf = buildVf(s);
    await runFFmpeg(inPath, outPath, vf, s.crf, s.preset);

    // معلومات بعد
    const after = await probe(outPath).catch(()=>({}));

    const caption = buildCaption(s, before, after);

    await ctx.replyWithVideo(
      { source: outPath },
      { caption, reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔁 إعادة المعالجة', 'reprocess')]
        ]).reply_markup
      }
    );
  } catch(e){
    console.error(e);
    await ctx.reply(`فشل التحسين: ${e.message}`);
  } finally {
    try{ fs.unlinkSync(inPath);}catch{}
    try{ fs.unlinkSync(outPath);}catch{}
    try{ await ctx.deleteMessage(wait.message_id);}catch{}
  }
}

// --------- فلاتر الفيديو ----------
function buildVf(s){
  const up = s.upscale || 1;
  const scale = up === 1
    ? 'scale=iw:ih'
    : `scale=iw*${up}:ih*${up}:flags=lanczos`;

  // كل الأوضاع تستخدم فلاتر آمنة، الاختلاف في قوة التنظيف والشحذ
  switch (s.mode) {
    case 'CLEAN':
      return [
        'hqdn3d=4:4:8:8',            // تنظيف قوي
        'unsharp=7:7:1.2:7:7:0.0',   // شحذ قوي
        scale
      ].join(',');

    case 'STAB': // نخليه "نعومة وثبات" بدون deshake عشان ما يطيح ffmpeg
      return [
        'hqdn3d=3:3:6:6',            // تنظيف متوسط
        'unsharp=6:6:1.0:6:6:0.0',   // شحذ متوسط
        scale
      ].join(',');

    case 'COLOR': // نخليه "واضح وحاد" بدون لعب كثير في الألوان عشان نتجنب eq
      return [
        'hqdn3d=2:2:6:6',            // تنظيف أخف
        'unsharp=5:5:0.8:5:5:0.0',   // شحذ خفيف
        scale
      ].join(',');

    case 'AUTO':
    default:
      return [
        'hqdn3d=2.0:2.0:6:6',        // تنظيف متوسط
        'unsharp=7:7:1.0:7:7:0.0',   // شحذ واضح
        scale
      ].join(',');
  }
}

// --------- أدوات مساعدة ----------
function download(url, dest){
  return new Promise((resolve, reject)=>{
    const ws = fs.createWriteStream(dest);
    https.get(url, res=>{
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(ws);
      res.on('error', reject);
      ws.on('finish', ()=>ws.close(resolve));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

function runFFmpeg(input, output, vf, crf=18, preset='veryfast'){
  return new Promise((resolve, reject)=>{
    const args = ['-y','-i',input,'-vf',vf,'-c:v','libx264','-preset',preset,'-crf',String(crf),'-c:a','copy',output];
    const p = spawn(FFMPEG, args, {stdio:['ignore','pipe','pipe']});
    let err=''; p.stderr.on('data',d=>err+=d.toString());
    p.on('close',c=> c===0 ? resolve() : reject(new Error(`ffmpeg (${c}): ${err.slice(0,500)}`)));
  });
}

function probe(path){
  return new Promise((resolve, reject)=>{
    const args = ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,codec_name,avg_frame_rate','-of','json',path];
    const p = spawn(FFPROBE, args, {stdio:['ignore','pipe','pipe']});
    let out=''; p.stdout.on('data',d=>out+=d.toString());
    let err=''; p.stderr.on('data',d=>err+=d.toString());
    p.on('close',c=>{
      if (c===0) {
        try{ const j = JSON.parse(out); const s = (j.streams||[])[0]||{}; resolve(s); }
        catch(e){ resolve({}); }
      } else reject(new Error(err || 'ffprobe failed'));
    });
  });
}

function buildCaption(s, before={}, after={}){
  const bsize = before.width && before.height ? `${before.width}x${before.height}` : '؟';
  const asize = after.width && after.height ? `${after.width}x${after.height}` : '؟';
  const bcodec = before.codec_name || '؟';
  const acodec = after.codec_name || 'h264';
  return [
    '✅ جاهز',
    `الوضع: ${modeName[s.mode]} | التكبير: ${s.upscale}x`,
    `CRF: ${s.crf} | السرعة: ${s.preset}`,
    `قبل: ${bsize} (${bcodec})`,
    `بعد:  ${asize} (${acodec})`,
    'تبي تغيّر؟ غيّر الإعدادات واضغط 🔁 إعادة المعالجة'
  ].join('\n');
}

bot.launch().then(()=>console.log('Bot started ✅'));
