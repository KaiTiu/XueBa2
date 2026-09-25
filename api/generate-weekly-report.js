// HOW TO SCORE A with AI
// Stage 5A - Weekly Growth Report V2
// Vercel Serverless Function: /api/generate-weekly-report

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htzkjfztqqsbzxahxfnt.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_-2O1fEqOGCQPSiMGQVSFrQ_bC3hf4WM";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res,status,body){res.status(status).json(body)}

async function fetchJson(url,options={}){
  const r=await fetch(url,options);
  const raw=await r.text();
  let data=null;
  try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok){
    const msg=data?.msg||data?.message||data?.error_description||data?.error||raw||`HTTP ${r.status}`;
    const e=new Error(msg);e.status=r.status;e.data=data;throw e;
  }
  return data;
}

async function getCallerUser(token){
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`,{
    headers:{apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}
  });
}

async function serviceRest(path,options={}){
  return fetchJson(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...options,
    headers:{
      apikey:SERVICE_ROLE_KEY,
      Authorization:`Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type":"application/json",
      Prefer:options.prefer||"return=representation",
      ...(options.headers||{})
    }
  });
}

async function callerIsAdmin(userId){
  const rows=await serviceRest(`user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.admin&select=role&limit=1`,{method:"GET"});
  return Array.isArray(rows)&&rows.length>0;
}

function isoDate(d){return d.toISOString().slice(0,10)}
function malaysiaDateParts(now=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kuala_Lumpur",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return {y:Number(get("year")),m:Number(get("month")),d:Number(get("day"))};
}
function parseDateOnly(s){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||"")))return null;
  const d=new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime())?null:d;
}
function defaultWeekEndMalaysia(){
  const p=malaysiaDateParts();
  const base=new Date(Date.UTC(p.y,p.m-1,p.d));
  const dow=base.getUTCDay();
  base.setUTCDate(base.getUTCDate()+((7-dow)%7));
  return isoDate(base);
}
function weekRange(weekEndInput){
  const end=parseDateOnly(weekEndInput||defaultWeekEndMalaysia());
  if(!end)throw new Error("week_end must use YYYY-MM-DD.");
  const dow=end.getUTCDay();
  end.setUTCDate(end.getUTCDate()+((7-dow)%7));
  const start=new Date(end);start.setUTCDate(start.getUTCDate()-6);
  const next=new Date(end);next.setUTCDate(next.getUTCDate()+1);
  return {
    week_start:isoDate(start),week_end:isoDate(end),
    fromIso:`${isoDate(start)}T00:00:00+08:00`,
    toExclusiveIso:`${isoDate(next)}T00:00:00+08:00`
  };
}
function unique(a){return [...new Set(a.filter(Boolean))]}
function countKeyword(body,words){
  const t=String(body||"").toLowerCase();
  return words.reduce((sum,w)=>sum+Math.max(0,t.split(String(w).toLowerCase()).length-1),0);
}
function malaysiaDateKey(value){
  const d=value instanceof Date?new Date(value):new Date(value||0);
  if(!Number.isFinite(d.getTime()))return "";
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kuala_Lumpur",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function analyzeTopics(reflections){
  // V2: analyse the student's own reflection text only.
  const body=(Array.isArray(reflections)?reflections:[])
    .map(r=>String(r.reflection_text||""))
    .join(" ");
  const topics=[
    ["粗心 / Carelessness",["粗心","看错","抄错","检查","careless","cuai"]],
    ["时间管理 / Time Management",["时间","来不及","拖延","安排","开始","time","procrast","masa","tangguh"]],
    ["专注 / Focus",["专注","分心","手机","游戏","干扰","focus","distract","phone","fokus","telefon"]],
    ["错题与复盘 / Mistakes & Review",["错题","错误","做错","订正","复盘","mistake","error","review","kesilapan","semak"]],
    ["复习与记忆 / Review & Memory",["复习","记忆","回忆","feynman","自测","revision","memory","recall","ulang kaji","ingatan"]],
    ["理解 / Understanding",["不会","不懂","理解","概念","卡住","understand","concept","faham","konsep"]],
    ["考试策略 / Exam Strategy",["考试","审题","分数","答题","紧张","exam","question","mark","peperiksaan","soalan"]],
    ["自主学习 / Independent Learning",["主动","计划","目标","自己","下一步","independent","goal","self","kendiri","matlamat"]]
  ];
  return topics.map(([name,words])=>({name,count:countKeyword(body,words)}))
    .filter(x=>x.count>0).sort((a,b)=>b.count-a.count);
}
function absoluteDay(progress){
  const local=Math.max(1,+progress?.current_day||1);
  if(local>30)return Math.min(365,local);
  const cycle=Math.max(1,+progress?.current_cycle||1);
  return Math.min(365,(cycle-1)*30+local);
}
function behaviorSignals(progress,reflections,range){
  const cs=(progress?.cycle_state&&typeof progress.cycle_state==="object")?progress.cycle_state:{};
  const app=(progress?.app_state&&typeof progress.app_state==="object")?progress.app_state:{};
  const read=(cs.read&&typeof cs.read==="object")?cs.read:{};
  const readAt=(cs.readCompletedAt&&typeof cs.readCompletedAt==="object")?cs.readCompletedAt:{};
  const thought=(cs.readThought&&typeof cs.readThought==="object")?cs.readThought:{};
  const time=(cs.time&&typeof cs.time==="object")?cs.time:{};
  const ai=(cs.ai&&typeof cs.ai==="object")?cs.ai:{};
  const rewarded=(app.rewarded&&typeof app.rewarded==="object")?app.rewarded:{};

  const dates=[];
  const start=parseDateOnly(range.week_start),end=parseDateOnly(range.week_end);
  if(start&&end){
    for(let d=new Date(start);d<=end;d.setUTCDate(d.getUTCDate()+1))dates.push(isoDate(d));
  }
  const dateSet=new Set(dates),buckets=new Map(dates.map(d=>[d,[]]));

  Object.entries(readAt).forEach(([key,when])=>{
    if(!/^\d+-\d+$/.test(key))return;
    const dk=malaysiaDateKey(when);
    if(dateSet.has(dk))buckets.get(dk).push(key);
  });

  // Fallback if some historical completion timestamps were missing.
  (Array.isArray(reflections)?reflections:[]).forEach(r=>{
    const key=`${Number(r.cycle_number)||0}-${Number(r.day_number)||0}`;
    const dk=malaysiaDateKey(r.completed_at);
    if(dateSet.has(dk)&&/^\d+-\d+$/.test(key)&&!buckets.get(dk).includes(key))buckets.get(dk).push(key);
  });

  let focusTotal=0,timeTotal=0,selfTotal=0,activeDays=0,taskDays=0;
  dates.forEach(dk=>{
    const keys=[...new Set(buckets.get(dk)||[])];
    if(!keys.length)return;
    activeDays++;
    let f=0,t=0,s=0;
    keys.forEach(key=>{
      const hasRead=!!read[key]||String(thought[key]||"").trim().length>0||!!readAt[key];
      const hasTime=!!time[key];
      const hasAI=!!ai[key];
      const hasChallenge=!!rewarded[`challenge-${key}`];
      f+=(hasAI?0.45:0)+(hasChallenge?0.55:0);
      t+=(hasTime?1:0);
      s+=(hasRead?0.35:0)+(hasAI?0.20:0)+(hasChallenge?0.45:0);
      taskDays++;
    });
    focusTotal+=f/keys.length;
    timeTotal+=t/keys.length;
    selfTotal+=s/keys.length;
  });

  const denom=Math.max(1,dates.length||7);
  const clamp=v=>Math.max(0,Math.min(100,Math.round(v)));
  return {
    focus:clamp((focusTotal/denom)*100),
    time_management:clamp((timeTotal/denom)*100),
    self_learning:clamp((selfTotal/denom)*100),
    active_days:activeDays,
    task_days:taskDays
  };
}
function strongestSkill(p){
  return [["专注习惯 / Focus Habit",+p?.focus||0],["时间管理习惯 / Time Management Habit",+p?.time_management||0],["自主学习习惯 / Independent Learning Habit",+p?.self_learning||0]]
    .sort((a,b)=>b[1]-a[1])[0];
}
function weakestSkill(p){
  return [["专注习惯 / Focus Habit",+p?.focus||0],["时间管理习惯 / Time Management Habit",+p?.time_management||0],["自主学习习惯 / Independent Learning Habit",+p?.self_learning||0]]
    .sort((a,b)=>a[1]-b[1])[0];
}

function buildReport({student,progress,reflections,range}){
  const clean=(Array.isArray(reflections)?reflections:[]).filter(r=>String(r.reflection_text||"").trim());
  const reflectionCount=clean.length;
  const activeDates=unique(clean.map(r=>malaysiaDateKey(r.completed_at)));
  const topics=analyzeTopics(clean);
  const signals=behaviorSignals(progress,clean,range);
  const strong=strongestSkill({focus:signals.focus,time_management:signals.time_management,self_learning:signals.self_learning});
  const weak=weakestSkill({focus:signals.focus,time_management:signals.time_management,self_learning:signals.self_learning});
  const strengths=[];

  if(activeDates.length>=5)strengths.push(`本周有 ${activeDates.length} 个实际学习日，学习节奏较稳定。`);
  else if(activeDates.length>0)strengths.push(`本周有 ${activeDates.length} 个实际学习日，共留下 ${reflectionCount} 次真实学习思考。`);
  else strengths.push("本周暂时没有足够的真实学习记录，先以稳定开始和完成每日任务为重点。");

  if(signals.task_days>0)strengths.push(`${strong[0]}是本周相对较明显的习惯信号（${strong[1]}%）。`);

  let improvementFocus=signals.task_days>0
    ?`${weak[0]}是下一阶段最值得优先训练的一项。`
    :"先建立稳定的每日学习节奏，再观察哪一项习惯最需要加强。";
  if(topics[0])improvementFocus+=` 最近思考中较常出现「${topics[0].name}」相关线索。`;

  const nextActions=[];
  if(weak[0].includes("专注")){
    nextActions.push("每天安排一个 25 分钟无手机专注区块。");
    nextActions.push("开始前只保留当前任务需要的资料。");
  }else if(weak[0].includes("时间")){
    nextActions.push("每天先写 Top 3，并为第一项任务设定明确开始时间。");
    nextActions.push("学习结束后比较“原计划、实际完成、卡住原因”。");
  }else{
    nextActions.push("每天由学生自己决定一个最重要的学习任务并主动开始。");
    nextActions.push("遇到不会的题，先独立思考，再使用 AI / 老师提示。");
  }
  if(topics[0]?.name.includes("错题"))nextActions.push("本周选择至少 2 题错题完成：找原因 → 重做 → 相似题再测试。");
  else if(topics[0]?.name.includes("考试"))nextActions.push("安排一次短时间限时练习，并在结束后记录失分原因。");
  else if(topics[0]?.name.includes("理解"))nextActions.push("选择一个知识点，用自己的话解释一次，再做一道不看答案的测试。");

  const parentTip=weak[0].includes("专注")
    ?"本周家长只协助孩子保护一个固定的无干扰学习时段，不需要不断提醒。"
    :weak[0].includes("时间")
    ?"本周可以每天只问孩子一句：‘你今天最重要的一件学习任务是什么？’"
    :"本周先让孩子自己说出计划与下一步，家长以提问代替直接给答案。";

  const latest=clean.slice(0,3);
  const reflectionSummary=latest.length
    ?latest.map(r=>`${r.lesson_title||`Day ${r.day_number||""}`}：${String(r.reflection_text||"").trim()}`).join("\n")
    :"本周暂时没有真实每日思考记录。";

  const absDay=absoluteDay(progress);
  return {
    student_id:student.id,
    week_start:range.week_start,week_end:range.week_end,
    current_cycle:+progress?.current_cycle||1,current_day:+progress?.current_day||1,xp:+progress?.xp||0,
    focus:signals.focus,time_management:signals.time_management,self_learning:signals.self_learning,
    reflection_count:reflectionCount,active_days:activeDates.length,
    strengths,improvement_focus:improvementFocus,trend_topics:topics.slice(0,5),next_actions:nextActions.slice(0,3),
    parent_tip:parentTip,reflection_summary:reflectionSummary,
    report_payload:{
      student:{student_id:student.student_id,full_name:student.full_name,grade:student.grade},
      week:{start:range.week_start,end:range.week_end},
      progress:{
        current_cycle:+progress?.current_cycle||1,current_day:+progress?.current_day||1,overall_day:absDay,xp:+progress?.xp||0,
        focus:signals.focus,time_management:signals.time_management,self_learning:signals.self_learning
      },
      behavior_signals:signals,
      active_days:activeDates,top_topics:topics.slice(0,5),recent_reflections:latest
    },
    status:"GENERATED",source_version:"weekly-report-v2",generated_at:new Date().toISOString(),updated_at:new Date().toISOString()
  };
}

module.exports=async function handler(req,res){
  if(req.method!=="POST"){
    res.setHeader("Allow","POST");
    return send(res,405,{ok:false,error:"Method not allowed"});
  }
  if(!SERVICE_ROLE_KEY)return send(res,500,{ok:false,error:"Server is missing SUPABASE_SERVICE_ROLE_KEY."});

  const auth=req.headers.authorization||"";
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!token)return send(res,401,{ok:false,error:"Admin login token is missing."});

  try{
    const caller=await getCallerUser(token);
    if(!caller?.id)return send(res,401,{ok:false,error:"Invalid Admin session."});
    if(!(await callerIsAdmin(caller.id)))return send(res,403,{ok:false,error:"This account does not have the admin role."});

    const body=req.body||{};
    const requested=String(body.student_id||body.student_uuid||body.scorea_student_id||"").trim();
    if(!requested)return send(res,400,{ok:false,error:"student_id is required."});

    const byUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requested);
    const studentPath=byUuid
      ?`students?id=eq.${encodeURIComponent(requested)}&select=id,student_id,full_name,grade,status&limit=1`
      :`students?student_id=eq.${encodeURIComponent(requested)}&select=id,student_id,full_name,grade,status&limit=1`;
    const studentRows=await serviceRest(studentPath,{method:"GET"});
    const student=studentRows?.[0];
    if(!student?.id)return send(res,404,{ok:false,error:"找不到这个学生。"});

    const range=weekRange(body.week_end);
    const progressRows=await serviceRest(`scorea_student_progress?student_id=eq.${encodeURIComponent(student.id)}&select=student_id,current_cycle,current_day,xp,focus,time_management,self_learning,app_state,cycle_state,updated_at&order=updated_at.desc&limit=1`,{method:"GET"});
    const progress=progressRows?.[0]||{current_cycle:1,current_day:1,xp:0,focus:0,time_management:0,self_learning:0};

    const reflections=await serviceRest(
      `scorea_daily_reflections?student_id=eq.${encodeURIComponent(student.id)}`+
      `&cycle_number=neq.999&lesson_type=neq.SYSTEM%20TEST`+
      `&completed_at=gte.${encodeURIComponent(range.fromIso)}`+
      `&completed_at=lt.${encodeURIComponent(range.toExclusiveIso)}`+
      `&select=student_id,student_name,cycle_number,day_number,lesson_title,lesson_question,reflection_text,completed_at,lesson_type&order=completed_at.desc`,
      {method:"GET"}
    );

    const report=buildReport({student,progress,reflections:Array.isArray(reflections)?reflections:[],range});
    const saved=await serviceRest(`scorea_weekly_reports?on_conflict=student_id,week_start,week_end`,{
      method:"POST",prefer:"resolution=merge-duplicates,return=representation",body:JSON.stringify(report)
    });

    return send(res,200,{ok:true,message:"Weekly Growth Report generated.",report:saved?.[0]||report,student:{id:student.id,student_id:student.student_id,full_name:student.full_name,grade:student.grade}});
  }catch(err){
    console.error("generate-weekly-report failed",err);
    return send(res,err.status||500,{ok:false,error:err.message||"Unable to generate weekly report.",detail:err.data||null});
  }
};
