export async function runDownloadBatch(ids:string[], save:(id:string)=>Promise<void>, options:{stop:()=>boolean;progress:(done:number,total:number)=>void}) {
  const unique=[...new Set(ids)], saved:string[]=[], failed:string[]=[]
  for(const id of unique){
    if(options.stop())break
    try{await save(id);saved.push(id)}catch{failed.push(id)}
    options.progress(saved.length+failed.length,unique.length)
  }
  return {saved,failed,remaining:unique.filter(id=>!saved.includes(id)&&!failed.includes(id))}
}
