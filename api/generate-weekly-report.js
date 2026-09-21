// HOW TO SCORE A with AI
// Stage 5A - Weekly Growth Report V1
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
function analyzeTopics(reflections){
  const body=reflections.map(r=>`${r.lesson_title||""} ${r.lesson_question||""} ${r.reflection_text||""}`).join(" ");
  const topics=[
    ["粗心 / Carelessness",["粗心","看错","抄错","careless","cuai"]],
    ["时间管理 / Time Management",["时间","来不及","拖延","安排","time","procrast","masa","tangguh"]],
    ["专注 / Focus",["专注","分心","手机","游戏","focus","distract","phone","fokus","telefon"]],
    ["错题与复盘 / Mistakes & Review",["错题","错误","订正","复盘","mistake","error","review","kesilapan","semak"]],
    ["复习与记忆 / Review & Memory",["复习","记忆","回忆","feynman","revision","memory","recall","ulang kaji","ingatan"]],
    ["理解 / Understanding",["不会","不懂","理解","概念","understand","concept","faham","konsep"]],
    ["考试策略 / Exam Strategy",["考试","审题","答题","紧张","exam","question","mark","peperiksaan","soalan"]],
    ["自主学习 / Independent Learning",["主动","自己","目标","下一步","independent","goal","self","kendiri","matlamat"]]
  ];
  return topics.map(([name,words])=>({name,count:countKeyword(body,words)})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count);
}
function strongestSkill(p){return [["专注力 / Focus",+p?.focus||0],["时间管理 / Time Management",+p?.time_management||0],["自主学习 / Independent Learning",+p?.self_learning||0]].sort((a,b)=>b[1]-a[1])[0]}
function weakestSkill(p){return [["专注力 / Focus",+p?.focus||0],["时间管理 / Time Management",+p?.time_management||0],["自主学习 / Independent Learning",+p?.self_learning||0]].sort((a,b)=>a[1]-b[1])[0]}

function buildReport({student,progress,reflections,range}){
  const reflectionCount=reflections.length;
  const activeDates=unique(reflections.map(r=>r.completed_at?String(r.completed_at).slice(0,10):""));
  const topics=analyzeTopics(reflections);
  const strong=strongestSkill(progress),weak=weakestSkill(progress);
  const strengths=[];
  if(reflectionCount>=5)strengths.push(`本周完成 ${reflectionCount} 次真实学习思考，学习记录较稳定。`);
  else if(reflectionCount>0)strengths.push(`本周已经留下 ${reflectionCount} 次真实学习思考。`);
  if(strong[1]>0)strengths.push(`${strong[0]}目前是较明显的成长信号（${strong[1]}%）。`);
  if(!strengths.length)strengths.push("目前仍在建立学习记录，先以稳定开始和完成每日任务为重点。");

  let improvementFocus=`${weak[0]}是下一阶段最值得优先训练的一项。`;
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

  const latest=reflections.slice(0,3);
  const reflectionSummary=latest.length
    ?latest.map(r=>`${r.lesson_title||`Day ${r.day_number||""}`}：${String(r.reflection_text||"").trim()||"已完成思考记录"}`).join("\n")
    :"本周暂时没有真实每日思考记录。";

  return {
    student_id:student.id,
    week_start:range.week_start,week_end:range.week_end,
    current_cycle:+progress?.current_cycle||1,current_day:+progress?.current_day||1,xp:+progress?.xp||0,
    focus:+progress?.focus||0,time_management:+progress?.time_management||0,self_learning:+progress?.self_learning||0,
    reflection_count:reflectionCount,active_days:activeDates.length,
    strengths,improvement_focus:improvementFocus,trend_topics:topics.slice(0,5),next_actions:nextActions.slice(0,3),
    parent_tip:parentTip,reflection_summary:reflectionSummary,
    report_payload:{
      student:{student_id:student.student_id,full_name:student.full_name,grade:student.grade},
      week:{start:range.week_start,end:range.week_end},
      progress:{current_cycle:+progress?.current_cycle||1,current_day:+progress?.current_day||1,xp:+progress?.xp||0,focus:+progress?.focus||0,time_management:+progress?.time_management||0,self_learning:+progress?.self_learning||0},
      active_days:activeDates,top_topics:topics.slice(0,5),recent_reflections:latest
    },
    status:"GENERATED",source_version:"weekly-report-v1",generated_at:new Date().toISOString(),updated_at:new Date().toISOString()
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
    const progressRows=await serviceRest(`scorea_student_progress?student_id=eq.${encodeURIComponent(student.id)}&select=student_id,current_cycle,current_day,xp,focus,time_management,self_learning,updated_at&order=updated_at.desc&limit=1`,{method:"GET"});
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
