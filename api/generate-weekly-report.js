// HOW TO SCORE A with AI
// Stage 5A - Manual Weekly Growth Report
// Vercel Function: /api/generate-weekly-report

const {weekRange,buildReport}=require("./_weekly-report-core");

const SUPABASE_URL=process.env.SUPABASE_URL||"https://htzkjfztqqsbzxahxfnt.supabase.co";
const SUPABASE_PUBLISHABLE_KEY=process.env.SUPABASE_PUBLISHABLE_KEY||"sb_publishable_-2O1fEqOGCQPSiMGQVSFrQ_bC3hf4WM";
const SERVICE_ROLE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res,status,body){res.status(status).json(body)}
async function fetchJson(url,options={}){
  const r=await fetch(url,options);const raw=await r.text();let data=null;
  try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok){
    const msg=data?.msg||data?.message||data?.error_description||data?.error||raw||`HTTP ${r.status}`;
    const e=new Error(msg);e.status=r.status;e.data=data;throw e;
  }
  return data;
}
async function getCallerUser(token){
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});
}
async function serviceRest(path,options={}){
  return fetchJson(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...options,
    headers:{apikey:SERVICE_ROLE_KEY,Authorization:`Bearer ${SERVICE_ROLE_KEY}`,"Content-Type":"application/json",Prefer:options.prefer||"return=representation",...(options.headers||{})}
  });
}
async function callerIsAdmin(userId){
  const rows=await serviceRest(`user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.admin&select=role&limit=1`,{method:"GET"});
  return Array.isArray(rows)&&rows.length>0;
}

module.exports=async function handler(req,res){
  if(req.method!=="POST"){
    res.setHeader("Allow","POST");return send(res,405,{ok:false,error:"Method not allowed"});
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
    const progressRows=await serviceRest(
      `scorea_student_progress?student_id=eq.${encodeURIComponent(student.id)}&select=student_id,current_cycle,current_day,xp,focus,time_management,self_learning,updated_at&order=updated_at.desc&limit=1`,
      {method:"GET"}
    );
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
