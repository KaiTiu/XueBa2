// HOW TO SCORE A with AI
// Stage 5A - Automatic Weekly Growth Reports
// Vercel Cron Function: /api/cron-weekly-reports
// Schedule: Sunday 12:00 UTC = Sunday 20:00 Malaysia.

const {weekRange,malaysiaToday,buildReport}=require("./_weekly-report-core");

const SUPABASE_URL=process.env.SUPABASE_URL||"https://htzkjfztqqsbzxahxfnt.supabase.co";
const SERVICE_ROLE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET=process.env.CRON_SECRET;

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
async function serviceRest(path,options={}){
  return fetchJson(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...options,
    headers:{apikey:SERVICE_ROLE_KEY,Authorization:`Bearer ${SERVICE_ROLE_KEY}`,"Content-Type":"application/json",Prefer:options.prefer||"return=representation",...(options.headers||{})}
  });
}
function chunks(arr,size){
  const out=[];for(let i=0;i<arr.length;i+=size)out.push(arr.slice(i,i+size));return out;
}
function inFilter(ids){return `in.(${ids.join(",")})`}

module.exports=async function handler(req,res){
  if(req.method!=="GET"){
    res.setHeader("Allow","GET");return send(res,405,{ok:false,error:"Method not allowed"});
  }
  if(!CRON_SECRET)return send(res,500,{ok:false,error:"Server is missing CRON_SECRET."});
  if((req.headers.authorization||"")!==`Bearer ${CRON_SECRET}`){
    return send(res,401,{ok:false,error:"Unauthorized"});
  }
  if(!SERVICE_ROLE_KEY)return send(res,500,{ok:false,error:"Server is missing SUPABASE_SERVICE_ROLE_KEY."});

  try{
    const range=weekRange();
    const today=malaysiaToday();

    const enrollments=await serviceRest(
      `enrollments?status=eq.ACTIVE&select=student_id,expiry_date`,
      {method:"GET"}
    );

    const activeStudentIds=[...new Set((enrollments||[])
      .filter(e=>e.student_id && (!e.expiry_date || e.expiry_date>=today))
      .map(e=>e.student_id))];

    if(!activeStudentIds.length){
      return send(res,200,{ok:true,message:"No ACTIVE students.",week_start:range.week_start,week_end:range.week_end,total:0,generated:0});
    }

    let generated=0,failed=0;
    const errors=[];

    for(const idChunk of chunks(activeStudentIds,100)){
      try{
        const filter=encodeURIComponent(inFilter(idChunk));

        const [students,progressRows,reflections]=await Promise.all([
          serviceRest(`students?id=${filter}&status=eq.ACTIVE&select=id,student_id,full_name,grade,status`,{method:"GET"}),
          serviceRest(`scorea_student_progress?student_id=${filter}&select=student_id,current_cycle,current_day,xp,focus,time_management,self_learning,updated_at&order=updated_at.desc`,{method:"GET"}),
          serviceRest(
            `scorea_daily_reflections?student_id=${filter}`+
            `&cycle_number=neq.999&lesson_type=neq.SYSTEM%20TEST`+
            `&completed_at=gte.${encodeURIComponent(range.fromIso)}`+
            `&completed_at=lt.${encodeURIComponent(range.toExclusiveIso)}`+
            `&select=student_id,student_name,cycle_number,day_number,lesson_title,lesson_question,reflection_text,completed_at,lesson_type&order=completed_at.desc`,
            {method:"GET"}
          )
        ]);

        const progressMap=new Map();
        for(const p of progressRows||[]){
          if(!progressMap.has(p.student_id))progressMap.set(p.student_id,p);
        }
        const reflectionMap=new Map();
        for(const r of reflections||[]){
          if(!reflectionMap.has(r.student_id))reflectionMap.set(r.student_id,[]);
          reflectionMap.get(r.student_id).push(r);
        }

        const reports=(students||[]).map(student=>buildReport({
          student,
          progress:progressMap.get(student.id)||{current_cycle:1,current_day:1,xp:0,focus:0,time_management:0,self_learning:0},
          reflections:reflectionMap.get(student.id)||[],
          range
        }));

        if(reports.length){
          await serviceRest(`scorea_weekly_reports?on_conflict=student_id,week_start,week_end`,{
            method:"POST",
            prefer:"resolution=merge-duplicates,return=minimal",
            body:JSON.stringify(reports)
          });
          generated+=reports.length;
        }
      }catch(err){
        failed+=idChunk.length;
        errors.push(err.message||"Unknown batch error");
      }
    }

    return send(res,200,{
      ok:failed===0,
      message:"Automatic weekly reports completed.",
      week_start:range.week_start,
      week_end:range.week_end,
      active_students:activeStudentIds.length,
      generated,
      failed,
      errors:errors.slice(0,10)
    });
  }catch(err){
    console.error("cron-weekly-reports failed",err);
    return send(res,err.status||500,{ok:false,error:err.message||"Unable to generate automatic weekly reports.",detail:err.data||null});
  }
};
