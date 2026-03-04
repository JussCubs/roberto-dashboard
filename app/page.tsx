'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell, CartesianGrid } from 'recharts'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const START = 494.69, GOAL = 1_000_000
const COLORS: Record<string,string> = {
  nowcast_mispricing:'#4488ff', cross_platform_arb:'#00ff88',
  structural_mispricing:'#aa66ff', time_decay:'#ffaa00', spread_capture:'#ff6688'
}

function fmt(n:number,d=2){return n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})}
function usd(n:number){return '$'+fmt(n)}

interface Trade{trade_id:string;ticker:string;action:string;side:string;count:number;price_cents:number;cost_dollars:number;fees_dollars:number;status:string;thesis:string;edge_source:string;fair_value_cents:number;estimated_edge_cents:number;confidence:string;event_ticker?:string;opened_at:string;exit_price_cents?:number;exit_date?:string;exit_reason?:string;pnl_dollars?:number;pnl_pct?:number}
interface Snap{total_value_dollars:number;balance_dollars:number;portfolio_value_dollars:number;open_positions:number;total_exposure_dollars:number;exposure_pct:number;captured_at:string}
interface MSnap{ticker:string;last_price:number;yes_bid:number;yes_ask:number;captured_at:string}
interface Decision{id:number;ticker:string;decision:string;side:string;reasoning:string;edge_source:string;estimated_edge_cents:number;decided_at:string}


const kalshiUrls: Record<string, string> = {
  'KXIMPEACH': 'https://kalshi.com/markets/kximpeach/president-impeached',
  'KXGDP-26APR30': 'https://kalshi.com/markets/kxgdp/us-gdp-growth',
  'KXUSAIRANAGREEMENT-27': 'https://kalshi.com/markets/kxusairanagreement/us-iran-nuclear-deal',
};
function kalshiUrl(t: Trade): string {
  const et = t.event_ticker || t.ticker.split('-')[0];
  return kalshiUrls[et] || ('https://kalshi.com/markets/' + et.toLowerCase());
}

export default function Page(){
  const [trades,setTrades]=useState<Trade[]>([])
  const [snaps,setSnaps]=useState<Snap[]>([])
  const [msnaps,setMsnaps]=useState<Record<string,MSnap>>({})
  const [decisions,setDecisions]=useState<Decision[]>([])
  const [beacon,setBeacon]=useState<{balance:number;portfolio_value:number;total_value:number}|null>(null)
  const [now,setNow]=useState(new Date())
  const [loaded,setLoaded]=useState(false)

  const fetch_=useCallback(async()=>{
    // Step 1: fetch trades first so we know which tickers to get snapshots for
    const [t,p,d,bq]=await Promise.all([
      supabase.from('trades').select('*').order('opened_at',{ascending:true}),
      supabase.from('portfolio_snapshots').select('*').order('captured_at',{ascending:true}),
      supabase.from('decisions').select('*').order('decided_at',{ascending:false}).limit(200),
      supabase.from('decisions').select('*').eq('ticker','__BALANCE__').order('decided_at',{ascending:false}).limit(1),
    ])
    if(t.data)setTrades(t.data)
    if(p.data)setSnaps(p.data)
    if(d.data)setDecisions(d.data.filter((x:Decision)=>x.ticker!=='__BALANCE__'))
    // Balance beacon — direct query for reliability
    if(bq.data&&bq.data.length>0){try{setBeacon(JSON.parse(bq.data[0].reasoning))}catch{}}

    // Step 2: fetch latest snapshot for EACH position ticker specifically
    if(t.data&&t.data.length>0){
      const openTickers=Array.from(new Set(t.data.filter(x=>x.status==='open').map(x=>x.ticker)))
      // Fetch latest snapshot per ticker using in() filter
      const s=await supabase.from('market_snapshots')
        .select('ticker,last_price,yes_bid,yes_ask,captured_at')
        .in('ticker',openTickers)
        .order('captured_at',{ascending:false})
        .limit(openTickers.length*5) // get a few per ticker to ensure coverage
      if(s.data){
        const m:Record<string,MSnap>={}
        for(const x of s.data)if(!m[x.ticker])m[x.ticker]=x
        setMsnaps(m)
      }
    }
    setLoaded(true)
  },[])

  useEffect(()=>{
    fetch_()
    // Realtime subscriptions — instant updates when DB changes
    const chan = supabase.channel('dashboard-realtime')
      .on('postgres_changes',{event:'*',schema:'public',table:'trades'},()=>fetch_())
      .on('postgres_changes',{event:'*',schema:'public',table:'portfolio_snapshots'},()=>fetch_())
      .on('postgres_changes',{event:'*',schema:'public',table:'decisions'},()=>fetch_())
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'decisions',filter:'ticker=eq.__BALANCE__'},()=>fetch_())
      .on('postgres_changes',{event:'*',schema:'public',table:'market_snapshots'},()=>fetch_())
      .subscribe()
    // Fallback poll every 60s in case realtime hiccups
    const i=setInterval(fetch_,60000)
    return()=>{chan.unsubscribe();clearInterval(i)}
  },[fetch_])
  useEffect(()=>{const i=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(i)},[])

  const latest=snaps[snaps.length-1]
  const openTrades=trades.filter(t=>t.status==='open')
  const closedTrades=trades.filter(t=>t.status==='closed')

  // Compute P&L per position from live market data (open) or exit price (closed)
  const withPnl=useMemo(()=>openTrades.map(t=>{
    const s=msnaps[t.ticker]
    const cur=s?(t.side==='no'?(100-s.last_price):s.last_price):t.price_cents
    const pnl=(cur-t.price_cents)*t.count/100
    const pnlPct=(cur-t.price_cents)/t.price_cents*100
    const elapsed=Date.now()-new Date(t.opened_at).getTime();const days=Math.floor(elapsed/864e5);const hrs=Math.floor((elapsed%864e5)/36e5);const mins=Math.floor((elapsed%36e5)/6e4);const age=days>0?days+'d '+hrs+'h':hrs>0?hrs+'h '+mins+'m':mins+'m'
    return{...t,cur,pnl,pnlPct,days,age,isOpen:true}
  }),[openTrades,msnaps])

  const closedWithPnl=useMemo(()=>closedTrades.map(t=>{
    const cur=t.exit_price_cents??t.price_cents
    const pnl=t.pnl_dollars??((cur-t.price_cents)*t.count/100)
    const pnlPct=t.pnl_pct??((cur-t.price_cents)/t.price_cents*100)
    const openDate=new Date(t.opened_at)
    const closeDate=t.exit_date?new Date(t.exit_date):new Date()
    const heldMs=closeDate.getTime()-openDate.getTime();const days=Math.floor(heldMs/864e5);const hrs=Math.floor((heldMs%864e5)/36e5)
    const age=days>0?days+'d':hrs+'h'
    return{...t,cur,pnl,pnlPct,days,age,isOpen:false}
  }),[closedTrades])

  const allPositions=useMemo(()=>[
    ...withPnl.sort((a,b)=>b.pnl-a.pnl),
    ...closedWithPnl.sort((a,b)=>b.pnl-a.pnl),
  ],[withPnl,closedWithPnl])

  // === CALCULATION MODEL ===
  //
  // Balance: from live Kalshi beacon (written by check.mjs every 30min to decisions table)
  // Fallback: latest portfolio snapshot, then START value
  // Market Value: Σ (current_price × count / 100) from live market data
  // Total Value: Balance + Market Value (= true account worth)
  // Total Gain: Total Value − $494.69

  const balance=beacon?.balance ?? latest?.balance_dollars ?? START
  const costBasis=openTrades.reduce((s,t)=>s+(t.cost_dollars||0),0)
  const totalFeesOpen=openTrades.reduce((s,t)=>s+(t.fees_dollars||0),0)
  const totalFeesClosed=closedTrades.reduce((s,t)=>s+(t.fees_dollars||0),0)
  const totalFees=totalFeesOpen+totalFeesClosed
  const computedMarketValue=withPnl.reduce((s,t)=>s+(t.cur*t.count/100),0)
  const marketValue=beacon?.portfolio_value ?? computedMarketValue  // prefer beacon (live Kalshi) over stale snapshots
  const unrealizedPnl=withPnl.reduce((s,t)=>s+t.pnl,0)  // sum of each row's P&L
  const realizedPnl=closedWithPnl.reduce((s,t)=>s+t.pnl,0) // sum of closed P&L
  const totalVal=beacon?.total_value ?? (balance+marketValue)  // prefer beacon total (live Kalshi)
  const totalGain=totalVal-START                         // net gain (after all fees)
  const totalGainPct=(totalGain/START)*100
  const totalPnl=unrealizedPnl                           // backward compat
  const goalPct=totalVal/GOAL*100
  const exposurePct=totalVal>0?(costBasis/totalVal*100):0
  const tablePnlSum=unrealizedPnl+realizedPnl            // what the table rows sum to

  const chartData=useMemo(()=>{
    const pts=[{time:'Start',value:START},...snaps.map(p=>({
      time:new Date(p.captured_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:TZ}),
      value:Number(p.total_value_dollars)
    }))]
    // Replace last point with live-computed value so chart matches cards
    if(pts.length>1){
      pts[pts.length-1]={...pts[pts.length-1],value:totalVal}
    }
    return pts
  },[snaps,totalVal,beacon])

  const posData=withPnl.map(t=>({
    name:t.ticker.replace(/^KX/,'').replace(/-26APR30-/,' ').replace(/-26-/,' ').replace(/-27-/,' ').slice(0,20),
    cost:t.cost_dollars,color:COLORS[t.edge_source]||'#555570'
  }))

  const edgeGroups=useMemo(()=>{
    const g:Record<string,{count:number;cost:number;edge:number}>={}
    openTrades.forEach(t=>{
      const s=t.edge_source||'unknown'
      if(!g[s])g[s]={count:0,cost:0,edge:0}
      g[s].count++;g[s].cost+=t.cost_dollars||0;g[s].edge+=t.estimated_edge_cents||0
    })
    return g
  },[openTrades])

  // Terminal entries: merge decisions + trades
  const terminalEntries=useMemo(()=>{
    const entries:{ts:string;type:string;ticker:string;text:string;detail:string;color:string}[]=[]
    decisions.forEach(d=>entries.push({
      ts:d.decided_at,type:d.decision.toUpperCase(),ticker:d.ticker||'',
      text:d.reasoning||'',detail:`edge:${d.estimated_edge_cents}¢ | ${d.edge_source?.replace(/_/g,' ')||''}`,
      color:d.decision==='trade'?'#00ff88':d.decision==='pass'?'#555570':'#ffaa00'
    }))
    trades.forEach(t=>entries.push({
      ts:t.opened_at,type:'EXEC',ticker:t.ticker,
      text:`${t.action.toUpperCase()} ${t.count}× ${t.side.toUpperCase()} @${t.price_cents}¢ — ${t.thesis}`,
      detail:`edge:${t.estimated_edge_cents}¢ fv:${t.fair_value_cents}¢ conf:${t.confidence} | ${t.edge_source?.replace(/_/g,' ')}`,
      color:'#00ff88'
    }))
    entries.sort((a,b)=>new Date(b.ts).getTime()-new Date(a.ts).getTime())
    return entries
  },[decisions,trades])

  const avgEdge=openTrades.length?(openTrades.reduce((s,t)=>s+(t.estimated_edge_cents||0),0)/openTrades.length):0

  if(!loaded)return(
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl mb-4">🎯</div>
        <div className="text-[var(--muted)] font-mono text-sm">Initializing Roberto...</div>
      </div>
    </div>
  )

  return(
    <div className="min-h-screen px-4 py-6 md:px-8 max-w-[1440px] mx-auto">
      {/* HEADER */}
      <header className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="text-4xl">🎯</div>
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight bg-gradient-to-r from-white via-[var(--text)] to-[var(--muted)] bg-clip-text text-transparent">
              ROBERTO
            </h1>
            <p className="text-[var(--muted)] text-xs tracking-[0.2em] uppercase">Autonomous Trading System</p>
          </div>
        </div>
        <div className="flex items-center gap-5 mt-4 md:mt-0">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--green)] pulse-glow"></span>
            <span className="font-mono text-xs text-[var(--muted)]">LIVE</span>
          </div>
          <div className="font-mono text-xs text-[var(--muted2)]">
            {now.toLocaleString('en-US',{timeZone:TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})} ET
          </div>
        </div>
      </header>

      {/* MISSION PROGRESS */}
      <div className="gradient-border rounded-xl p-5 mb-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3">
          <div>
            <span className="text-xs text-[var(--muted)] uppercase tracking-wider">Mission Progress</span>
            <div className="flex items-baseline gap-3 mt-1">
              <span className="font-mono text-2xl font-bold text-[var(--text)]">{usd(totalVal)}</span>
              <span className="text-[var(--muted)] font-mono text-sm">→</span>
              <span className="font-mono text-lg text-[var(--muted2)]">{usd(GOAL)}</span>
            </div>
          </div>
          <div className="text-right">
            <span className={`font-mono text-lg font-bold ${totalGain>=0?'text-[var(--green)] glow-green':'text-[var(--red)] glow-red'}`}>
              {totalGain>=0?'+':''}{usd(totalGain)}
            </span>
            <div className="font-mono text-xs text-[var(--muted)]">{totalGain>=0?'+':''}{totalGainPct.toFixed(2)}% total gain (after fees)</div>
          </div>
        </div>
        <div className="relative w-full h-3 bg-[var(--bg)] rounded-full overflow-hidden">
          <div className="absolute inset-0 shimmer rounded-full"></div>
          <div className="relative h-full bg-gradient-to-r from-[var(--blue)] via-[var(--purple)] to-[var(--green)] rounded-full transition-all duration-1000 ease-out"
               style={{width:`${Math.max(0.3,goalPct)}%`}}>
            <div className="absolute right-0 top-0 bottom-0 w-1 bg-white/30 rounded-full"></div>
          </div>
        </div>
        <div className="flex justify-between mt-2">
          <span className="font-mono text-[10px] text-[var(--muted2)]">$494.69</span>
          <span className="font-mono text-[10px] text-[var(--green)]">{goalPct.toFixed(4)}% complete</span>
          <span className="font-mono text-[10px] text-[var(--muted2)]">$1,000,000</span>
        </div>
      </div>

      {/* METRIC CARDS */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <Card label="Total Value" value={usd(totalVal)} sub={<><span className="font-mono">{usd(balance)}</span> cash + <span className="font-mono">{usd(marketValue)}</span> positions{beacon?' ✓':' ⚠️'}</>} accent={totalGain>=0?'green':'red'} />
        <Card label="Total Gain" value={`${totalGain>=0?'+':''}${usd(totalGain)}`} sub={<>Since {usd(START)} start (from Kalshi)</>} accent={totalGain>=0?'green':'red'} />
        <Card label="Unrealized P&L" value={`${unrealizedPnl>=0?'+':''}${usd(unrealizedPnl)}`} sub={<>Σ open rows below ({openTrades.length})</>} accent={unrealizedPnl>=0?'green':'red'} />
        <Card label="Realized P&L" value={`${realizedPnl>=0?'+':''}${usd(realizedPnl)}`} sub={<>Σ closed rows below ({closedTrades.length})</>} accent={realizedPnl>=0?'green':'red'} />
        <Card label="Fees Paid" value={usd(totalFees)} sub={<>Tracked trades | {exposurePct.toFixed(1)}% exp</>} />
      </div>

      {/* CHARTS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
        <div className="gradient-border rounded-xl p-5">
          <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-[0.15em] mb-4">Portfolio Value Over Time</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00ff88" stopOpacity={0.25}/>
                  <stop offset="100%" stopColor="#00ff88" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
              <XAxis dataKey="time" stroke="#44445a" fontSize={10} fontFamily="JetBrains Mono" />
              <YAxis stroke="#44445a" fontSize={10} fontFamily="JetBrains Mono" domain={['dataMin-10','dataMax+10']} tickFormatter={(v:number)=>`$${v}`} />
              <Tooltip contentStyle={{background:'#0d0d14',border:'1px solid #1a1a2e',borderRadius:12,fontFamily:'JetBrains Mono',fontSize:12,boxShadow:'0 8px 32px rgba(0,0,0,.5)'}} formatter={(v:number)=>[`$${fmt(v)}`,'Value']} />
              <Area type="monotone" dataKey="value" stroke="#00ff88" fill="url(#grad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="gradient-border rounded-xl p-5">
          <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-[0.15em] mb-4">Position Allocation</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={posData} layout="vertical" margin={{left:5}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
              <XAxis type="number" stroke="#44445a" fontSize={10} fontFamily="JetBrains Mono" tickFormatter={(v:number)=>`$${v}`} />
              <YAxis type="category" dataKey="name" stroke="#44445a" fontSize={9} fontFamily="JetBrains Mono" width={120} />
              <Tooltip contentStyle={{background:'#0d0d14',border:'1px solid #1a1a2e',borderRadius:12,fontFamily:'JetBrains Mono',fontSize:12}} />
              <Bar dataKey="cost" name="Cost" radius={[0,6,6,0]} barSize={20}>
                {posData.map((e,i)=><Cell key={i} fill={e.color} fillOpacity={0.8}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* POSITIONS TABLE — open first (by P&L), then closed (by P&L) */}
      <div className="gradient-border rounded-xl mb-6 overflow-hidden">
        <div className="p-4 border-b border-[var(--border)]">
          <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-[0.15em]">All Positions <span className="text-[var(--muted2)] ml-2">{openTrades.length} open · {closedTrades.length} closed</span></h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--muted2)] text-[10px] uppercase tracking-wider">
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Ticker</th>
                <th className="p-2 text-left">Side</th>
                <th className="p-2 text-right">Qty</th>
                <th className="p-2 text-right">Entry</th>
                <th className="p-2 text-right">{`Now / Exit`}</th>
                <th className="p-2 text-right">P&L</th>
                <th className="p-2 text-left">Edge</th>
                <th className="p-2 text-left">Thesis</th>
              </tr>
            </thead>
            <tbody>
              {allPositions.map((t,i)=>(
                <tr key={t.trade_id} className={`border-b border-[var(--border)] hover:bg-[var(--surface2)] transition-colors animate-fade-up ${!t.isOpen?'opacity-60':''}`} style={{animationDelay:`${i*60}ms`}}>
                  <td className="p-2">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${t.isOpen?'bg-[rgba(0,255,136,.1)] text-[var(--green)]':'bg-[rgba(255,255,255,.05)] text-[var(--muted)]'}`}>
                      {t.isOpen?'OPEN':'CLOSED'}
                    </span>
                  </td>
                  <td className="p-2 font-mono font-semibold text-[var(--text)] text-xs whitespace-nowrap">
                    <a href={`${kalshiUrl(t)}`} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--accent)] hover:underline transition-colors">{t.ticker}</a> <span className="text-[10px] text-[var(--muted2)] font-normal ml-1">{t.age}</span>
                  </td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${t.side==='yes'?'bg-[rgba(0,255,136,.1)] text-[var(--green)]':'bg-[rgba(255,68,87,.1)] text-[var(--red)]'}`}>{t.side}</span></td>
                  <td className="p-2 text-right font-mono text-xs">{t.count}</td>
                  <td className="p-2 text-right font-mono text-xs text-[var(--muted)]">{t.price_cents}¢</td>
                  <td className="p-2 text-right font-mono text-xs">{t.cur}¢</td>
                  <td className={`p-3 text-right font-mono text-xs font-bold ${t.pnl>=0?'text-[var(--green)]':'text-[var(--red)]'}`}>
                    {t.pnl>=0?'+':''}{usd(t.pnl)}<br/>
                    <span className="text-[var(--muted2)] font-normal">({t.pnlPct>=0?'+':''}{Number(t.pnlPct).toFixed(1)}%)</span>
                  </td>
                  <td className="p-3"><span className="px-2 py-0.5 rounded-md text-[10px] whitespace-nowrap" style={{background:(COLORS[t.edge_source]||'#555')+'18',color:COLORS[t.edge_source]||'#555'}}>{t.edge_source?.replace(/_/g,' ')}</span></td>
                  <td className="p-2 text-[var(--muted)] text-[11px] max-w-[300px]" title={t.isOpen?t.thesis:(t.exit_reason||t.thesis)}><div className="line-clamp-2">{t.isOpen?t.thesis:(t.exit_reason||t.thesis)}</div></td>
                </tr>
              ))}
              {!allPositions.length&&<tr><td colSpan={9} className="p-8 text-center text-[var(--muted)]">Loading positions...</td></tr>}
              {allPositions.length>0&&(
                <tr className="border-t-2 border-[var(--border)] bg-[var(--surface2)]">
                  <td colSpan={6} className="p-3 text-right font-mono text-xs text-[var(--muted)]">
                    Table P&L Sum (Unrealized + Realized)
                  </td>
                  <td className={`p-3 text-right font-mono text-xs font-bold ${tablePnlSum>=0?'text-[var(--green)]':'text-[var(--red)]'}`}>
                    {tablePnlSum>=0?'+':''}{usd(tablePnlSum)}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* DECISION TERMINAL */}
      <div className="rounded-xl border border-[#21262d] mb-6 overflow-hidden">
        <div className="px-4 py-3 bg-[#0d1117] border-b border-[#21262d] flex items-center gap-3">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-[#ff5f56]"></span>
            <span className="w-3 h-3 rounded-full bg-[#ffbd2e]"></span>
            <span className="w-3 h-3 rounded-full bg-[#27c93f]"></span>
          </div>
          <span className="text-[11px] text-[#6e7681] font-mono flex-1">roberto@kalshi ~ tail -f decisions.log</span>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#27c93f] pulse-glow"></span>
            <span className="text-[10px] text-[#6e7681] font-mono">LIVE</span>
          </div>
        </div>
        <div className="bg-[#0d1117] p-4 h-[450px] overflow-y-auto terminal-scroll font-mono text-[11px] leading-[1.8]">
          {terminalEntries.length===0&&(
            <div className="text-[#6e7681]">
              <div>$ connecting to decision engine...</div>
              <div>$ authenticated ✓</div>
              <div>$ waiting for entries...</div>
              <div className="mt-2">{trades.length>0?'':'No decisions recorded yet.'}</div>
            </div>
          )}
          {terminalEntries.map((e,i)=>(
            <div key={i} className="mb-4 animate-slide-in" style={{animationDelay:`${i*30}ms`}}>
              <div className="flex items-center gap-2">
                <span className="text-[#484f58]">{new Date(e.ts).toLocaleString('en-US',{timeZone:TZ,month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</span>
                <span className="font-bold" style={{color:e.color}}>[{e.type}]</span>
                {e.ticker&&<span className="text-[var(--amber)]">{e.ticker}</span>}
              </div>
              <div className="pl-4 ml-2 border-l border-[#21262d]">
                <div className="text-[#c9d1d9]">{e.text}</div>
                <div className="text-[#484f58]">{e.detail}</div>
              </div>
            </div>
          ))}
          <div className="text-[#27c93f] mt-2">
            <span className="text-[#484f58]">$</span> <span className="blink">█</span>
          </div>
        </div>
      </div>

      {/* EDGE PERFORMANCE */}
      <div className="gradient-border rounded-xl mb-8 overflow-hidden">
        <div className="p-4 border-b border-[var(--border)]">
          <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-[0.15em]">Edge Source Analysis</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--muted2)] text-[10px] uppercase tracking-wider">
                <th className="p-2 text-left">Strategy</th>
                <th className="p-2 text-right">Trades</th>
                <th className="p-2 text-right">Total Cost</th>
                <th className="p-2 text-right">Avg Edge (Est)</th>
                <th className="p-2 text-left">Strength</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(edgeGroups).map(([src,d])=>(
                <tr key={src} className="border-b border-[var(--border)] hover:bg-[var(--surface2)] transition-colors">
                  <td className="p-3"><span className="px-2 py-1 rounded-md text-xs font-medium" style={{background:(COLORS[src]||'#555')+'18',color:COLORS[src]||'#555'}}>{src.replace(/_/g,' ')}</span></td>
                  <td className="p-2 text-right font-mono">{d.count}</td>
                  <td className="p-2 text-right font-mono">{usd(d.cost)}</td>
                  <td className="p-2 text-right font-mono">{(d.edge/d.count).toFixed(1)}¢</td>
                  <td className="p-2 w-32">
                    <div className="w-full h-2 bg-[var(--bg)] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{width:`${Math.min(100,d.edge/d.count*8)}%`,background:COLORS[src]||'#555'}}></div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* FOOTER */}
      <footer className="text-center py-8 border-t border-[var(--border)]">
        <div className="text-[var(--muted2)] text-xs font-mono">
          Powered by <span className="text-[var(--text)]">Roberto 🎯</span> • Data refreshes every 30s • <a href="https://kalshi.com" className="text-[var(--blue)] hover:underline" target="_blank" rel="noreferrer">Kalshi</a>
        </div>
      </footer>
    </div>
  )
}

function Card({label,value,sub,accent}:{label:string;value:string;sub:React.ReactNode;accent?:string}){
  const c=accent==='green'?'var(--green)':accent==='red'?'var(--red)':accent==='blue'?'var(--blue)':'var(--text)'
  const glow=accent==='green'?'glow-green':accent==='red'?'glow-red':accent==='blue'?'glow-blue':''
  return(
    <div className="gradient-border rounded-xl p-4 card-hover animate-fade-up">
      <div className="text-[10px] text-[var(--muted)] uppercase tracking-[0.15em] mb-2 font-medium">{label}</div>
      <div className={`text-xl md:text-2xl font-bold font-mono ${glow}`} style={{color:c}}>{value}</div>
      <div className="text-[11px] text-[var(--muted)] mt-1.5">{sub}</div>
    </div>
  )
}
