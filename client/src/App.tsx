import { Component, createContext, useCallback, useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell
} from 'recharts'
import './index.css'

const PlayerClickContext = createContext<(id: number, name: string, x: number, y: number) => void>(() => {})

const SLOT_LABELS: Record<number, string> = {
  0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C',
  5: 'PG', 6: 'SG', 7: 'SF', 8: 'PF', 9: 'C',
  10: 'G', 11: 'F', 12: 'UTIL', 13: 'BE', 14: 'BE', 15: 'BE',
  16: 'IR', 17: 'IR',
}

interface Player {
  name: string
  playerId?: number
  position: number
  injuryStatus: string | null
  stats?: number
  hasGame?: boolean
  opponent?: string | null
  gameTime?: string | null
  gameSortKey?: number | null
  broadcast?: string | null
  gameStatus?: string | null
  proTeamAbbrev?: string | null
}

interface TeamData {
  id: number
  name: string
  abbrev: string
  totalPoints: number
  record?: { wins: number; losses: number; ties: number }
  roster: Player[]
  todayRoster: Player[]
}

interface Matchup {
  matchupPeriodId: number
  myTeamId: number
  home: TeamData
  away: TeamData | null
}

interface ActivePlayer {
  name: string
  playerId: number | null
  avg: number
  counts: boolean
  isStretchAdd?: boolean
}

interface DayRoster {
  label: string
  myPlayers: ActivePlayer[]
  oppPlayers: ActivePlayer[]
}

interface TeamPercentiles {
  name: string
  p10: number; p25: number; p50: number; p75: number; p90: number
}

interface SimResult {
  winProbability: number
  myTeam: TeamPercentiles
  opponent: TeamPercentiles
  histogram: { range: string; count: number; win: boolean }[]
  n: number
}

interface ProjectionData {
  labels: string[]
  myTeam: { name: string; scores: number[] }
  opponent: { name: string; scores: number[] }
  days: DayRoster[]
  droppedPlayers: { name: string; replacedBy: string }[]
}

interface FreeAgent {
  name: string
  playerId: number
  proTeam: string
  position?: string
  avg: number
  gamesLeft: number
  projectedTotal: number
  injuryStatus: string
  ownership: number
}

interface FreeAgentsData {
  dropCandidates: FreeAgent[]
  players: FreeAgent[]
  remainingDates: string[]
  scheduleAdjusted: boolean
}

interface VsAvgGame {
  date: string
  atVs: string
  oppAbbr: string
  expectedFPTS: number
  usedFallback: boolean
  history: { date: string; result: string; FPTS: number }[]
}

interface VsAvgPlayer {
  name: string
  playerId: number
  proTeam: string
  position?: string
  seasonAvg: number
  games: VsAvgGame[]
  expectedTotal: number
}

interface VsAvgData {
  myPlayers: VsAvgPlayer[]
  faPlayers: VsAvgPlayer[]
}

interface PlayerStats {
  name: string
  position: string
  proTeam: string
  injuryStatus: string
  statLabels: string[]
  season: string[]
  l10: string[]
  fantasyAvg: number | null
  fantasyRecent: number | null
  upcomingGames: { date: string; label: string; oppRecord: string; broadcast: string | null; history: { date: string; atVs: string; result: string; FPTS: string }[] }[]
  last5Games: { date: string; atVs: string; opponent: string; result: string; FPTS?: string; PTS?: string; REB?: string; AST?: string; STL?: string; BLK?: string; TO?: string; '3PM'?: string; MIN?: string }[]
  percentOwned: number | null
}

type Tab = 'matchup' | 'projection' | 'simulate' | 'freeagents' | 'falast5' | 'vsavg'

class TabErrorBoundary extends Component<{ tabKey: string; children: React.ReactNode }, { error: string | null }> {
  constructor(props: { tabKey: string; children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromProps(_: unknown, state: { error: string | null }) {
    return state
  }
  static getDerivedStateFromError(e: Error) { return { error: e.message } }
  componentDidUpdate(prev: { tabKey: string }) {
    if (prev.tabKey !== this.props.tabKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (this.state.error) return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <p className="text-red-400 text-sm">Something went wrong rendering this tab.</p>
        <button className="text-xs text-gray-400 underline" onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    )
    return this.props.children
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('matchup')
  const [matchup, setMatchup] = useState<Matchup | null>(null)
  const [projection, setProjection] = useState<ProjectionData | null>(null)
  const [simResult, setSimResult] = useState<SimResult | null>(null)
  const [freeAgents, setFreeAgents] = useState<FreeAgentsData | null>(null)
  const [freeAgentsL5, setFreeAgentsL5] = useState<FreeAgentsData | null>(null)
  const [simForTrades, setSimForTrades] = useState<SimResult | null>(null)
  const [vsAvg, setVsAvg] = useState<VsAvgData | null>(null)
  const [vsAvgDrops, setVsAvgDrops] = useState<Set<number>>(new Set())
  const [vsAvgAdds, setVsAvgAdds] = useState<Set<number>>(new Set())
  const [simForVsAvg, setSimForVsAvg] = useState<SimResult | null>(null)
  const [selectedDrops, setSelectedDrops] = useState<Set<number>>(new Set())
  const [selectedAdds, setSelectedAdds] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [matchupFetchedAt, setMatchupFetchedAt] = useState<number>(0)
  const [simFetchedAt, setSimFetchedAt] = useState<number>(0)
  const [playerModal, setPlayerModal] = useState<{ playerId: number; name: string; x: number; y: number } | null>(null)
  const handlePlayerClick = useCallback((id: number, name: string, x: number, y: number) => setPlayerModal({ playerId: id, name, x, y }), [])

  const doFetch = useCallback((currentTab: Tab) => {
    const urls: Record<Tab, string> = {
      matchup: '/api/matchup',
      projection: '/api/projection',
      simulate: '/api/simulate',
      freeagents: '/api/freeagents',
      falast5: '/api/freeagents?period=l5',
      vsavg: '/api/vs-avg',
    }
    setLoading(true)
    setError(null)
    const isFATab = currentTab === 'freeagents' || currentTab === 'falast5'
    const fetches = [fetch(urls[currentTab]).then(r => r.json())]
    if (isFATab) fetches.push(fetch('/api/simulate').then(r => r.json()))
    Promise.all(fetches)
      .then(([data, simData]) => {
        if (data.error) { setError(data.error); return }
        if (currentTab === 'matchup') { setMatchup(data); setMatchupFetchedAt(Date.now()) }
        else if (currentTab === 'projection') setProjection(data)
        else if (currentTab === 'simulate') { setSimResult(data); setSimFetchedAt(Date.now()) }
        else if (currentTab === 'freeagents') { setFreeAgents(data); if (simData && !simData.error) { setSimForTrades(simData); setSimFetchedAt(Date.now()) } }
        else if (currentTab === 'falast5') { setFreeAgentsL5(data); if (simData && !simData.error) { setSimForTrades(simData); setSimFetchedAt(Date.now()) } }
        else if (currentTab === 'vsavg') {
          setVsAvg(data)
          fetch('/api/simulate').then(r => r.json()).then(s => { if (!s.error) { setSimForVsAvg(s); setSimFetchedAt(Date.now()) } }).catch(() => {})
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { doFetch(tab) }, [tab, doFetch])

  // Auto-refresh matchup tab if data is older than 1 hour
  useEffect(() => {
    if (tab !== 'matchup') return
    const interval = setInterval(() => {
      if (Date.now() - matchupFetchedAt > 60 * 60 * 1000) doFetch('matchup')
    }, 60 * 1000)
    return () => clearInterval(interval)
  }, [tab, matchupFetchedAt, doFetch])

  // Background hourly sim refresh between noon and midnight
  useEffect(() => {
    const interval = setInterval(() => {
      const hour = new Date().getHours()
      if (hour < 12 || hour >= 24) return
      if (Date.now() - simFetchedAt < 60 * 60 * 1000) return
      fetch('/api/simulate').then(r => r.json()).then(s => {
        if (s.error) return
        setSimResult(s)
        setSimForTrades(s)
        setSimForVsAvg(s)
        setSimFetchedAt(Date.now())
      }).catch(() => {})
    }, 60 * 1000)
    return () => clearInterval(interval)
  }, [simFetchedAt])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'matchup', label: 'Matchup' },
    { id: 'projection', label: 'Projection' },
    { id: 'simulate', label: 'Simulate' },
    { id: 'freeagents', label: 'Free Agents' },
    { id: 'falast5', label: 'FA Last 5' },
    { id: 'vsavg', label: 'VS Avg' },
  ]

  return (
    <PlayerClickContext.Provider value={handlePlayerClick}>
    {playerModal && <PlayerStatsModal playerId={playerModal.playerId} name={playerModal.name} x={playerModal.x} y={playerModal.y} onClose={() => setPlayerModal(null)} />}
    <div className="min-h-screen bg-gray-950 text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap gap-1 mb-6 bg-gray-900 rounded-xl p-1 w-fit mx-auto">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading && <div className="text-center text-gray-500 text-sm py-20">{tab === 'vsavg' ? 'Calculating matchup-adjusted projections…' : 'Loading...'}</div>}
        {error && <div className="text-center text-red-400 text-sm py-20">{error}</div>}

        <TabErrorBoundary tabKey={tab}>
          {!loading && !error && tab === 'matchup' && matchup && <MatchupView matchup={matchup} />}
          {!loading && !error && tab === 'projection' && projection && <ProjectionView data={projection} />}
          {!loading && !error && tab === 'simulate' && simResult && <SimulateView key={tab} data={simResult} />}
          {!loading && !error && tab === 'vsavg' && vsAvg && (() => {
            const toggleDrop = (id: number) => setVsAvgDrops(prev => {
              const s = new Set(prev); if (s.has(id)) { s.delete(id); setVsAvgAdds(a => { const sa = new Set(a); if (sa.size > s.size) sa.delete([...sa].at(-1)!); return sa }) } else s.add(id); return s
            })
            const toggleAdd = (id: number) => setVsAvgAdds(prev => {
              const s = new Set(prev); if (s.has(id)) { s.delete(id); return s }
              if (s.size >= vsAvgDrops.size) return prev; s.add(id); return s
            })
            return <VsAvgView key={tab} data={vsAvg} sim={simForVsAvg} selectedDrops={vsAvgDrops} selectedAdds={vsAvgAdds} onToggleDrop={toggleDrop} onToggleAdd={toggleAdd} />
          })()}
          {!loading && !error && (tab === 'freeagents' || tab === 'falast5') && (freeAgents || freeAgentsL5) && (() => {
            const data = tab === 'freeagents' ? freeAgents! : freeAgentsL5!
            const toggleDrop = (id: number) => setSelectedDrops(prev => {
              const s = new Set(prev)
              if (s.has(id)) { s.delete(id); setSelectedAdds(a => { const sa = new Set(a); if (sa.size > s.size) sa.delete([...sa].at(-1)!); return sa }) }
              else s.add(id)
              return s
            })
            const toggleAdd = (id: number) => setSelectedAdds(prev => {
              const s = new Set(prev)
              if (s.has(id)) { s.delete(id); return s }
              if (s.size >= selectedDrops.size) return prev
              s.add(id); return s
            })
            return <FreeAgentsView key={tab} data={data} sim={simForTrades} selectedDrops={selectedDrops} selectedAdds={selectedAdds} onToggleDrop={toggleDrop} onToggleAdd={toggleAdd} />
          })()}
        </TabErrorBoundary>
      </div>
    </div>
    </PlayerClickContext.Provider>
  )
}

function ProjectionView({ data }: { data: ProjectionData }) {
  const [selectedDay, setSelectedDay] = useState<DayRoster | null>(null)
  const onPlayerClick = useContext(PlayerClickContext)

  const chartData = data.labels.map((label, i) => ({
    date: label,
    [data.myTeam.name]: data.myTeam.scores[i],
    [data.opponent.name]: data.opponent.scores[i],
  }))

  const myFinal = data.myTeam.scores[data.myTeam.scores.length - 1]
  const oppFinal = data.opponent.scores[data.opponent.scores.length - 1]
  const myWinning = myFinal > oppFinal

  const crossoverDates = data.labels.filter((_, i) => {
    if (i === 0) return false
    const myPrev = data.myTeam.scores[i - 1], oppPrev = data.opponent.scores[i - 1]
    const myCur = data.myTeam.scores[i], oppCur = data.opponent.scores[i]
    return (myPrev < oppPrev && myCur >= oppCur) || (myPrev > oppPrev && myCur <= oppCur)
  })

  function handleChartClick(e: any) {
    const label = e?.activeLabel ?? e?.activePayload?.[0]?.payload?.date
    if (!label) return
    const day = data.days.find(d => d.label === label)
    setSelectedDay(day ?? null)
  }

  return (
    <div className="relative">
      <div className="flex justify-between items-end mb-6 px-1">
        <div>
          <p className="text-xs text-gray-500 mb-1">Championship ends Apr 5 · click a day for rosters</p>
          <p className={`text-sm font-semibold ${myWinning ? 'text-green-400' : 'text-red-400'}`}>
            Projected to {myWinning ? 'WIN' : 'LOSE'} {myFinal} – {oppFinal}
          </p>
        </div>
      </div>

      <div className="bg-gray-900 rounded-2xl p-4 mb-6">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} onClick={handleChartClick} style={{ cursor: 'pointer' }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 11 }} />
            <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} width={48} />
            <Tooltip
              contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
              labelStyle={{ color: '#9ca3af' }}
              itemStyle={{ color: '#e5e7eb' }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af' }} />
            {crossoverDates.map(d => (
              <ReferenceLine key={d} x={d} stroke="#4b5563" strokeDasharray="4 4" />
            ))}
            <Line type="monotone" dataKey={data.myTeam.name} stroke="#60a5fa" strokeWidth={2} dot={{ fill: '#60a5fa', r: 3 }} activeDot={{ r: 5 }} />
            <Line type="monotone" dataKey={data.opponent.name} stroke="#f87171" strokeWidth={2} dot={{ fill: '#f87171', r: 3 }} activeDot={{ r: 5 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {[
          { team: data.myTeam, color: 'text-blue-400', isYou: true },
          { team: data.opponent, color: 'text-red-400', isYou: false },
        ].map(({ team, color, isYou }) => (
          <div key={team.name} className="bg-gray-900 rounded-2xl p-4">
            {isYou && <p className="text-xs text-blue-400 mb-1">You</p>}
            <p className="text-sm font-semibold text-white">{team.name}</p>
            <p className={`text-3xl font-bold mt-2 tabular-nums ${color}`}>{team.scores[team.scores.length - 1]}</p>
            <p className="text-xs text-gray-500 mt-1">projected final</p>
          </div>
        ))}
      </div>

      {data.droppedPlayers.length > 0 && (
        <div className="bg-gray-900 rounded-2xl p-4">
          <p className="text-xs text-yellow-400 uppercase tracking-wider font-semibold mb-3">
            Stretch Run Adds ({data.droppedPlayers.length} of 5)
          </p>
          <div className="space-y-2">
            {data.droppedPlayers.map((d, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{d.name}</span>
                <span className="text-gray-600 mx-2">→ empty days filled by</span>
                <span className="text-yellow-400 font-medium">{d.replacedBy} (25 pts)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sidebar */}
      {selectedDay && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedDay(null)}>
          <div
            className="w-full max-w-md bg-gray-900 h-full overflow-y-auto shadow-2xl border-l border-gray-800"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 sticky top-0 bg-gray-900">
              <p className="font-semibold text-white">Active Rosters — {selectedDay.label}</p>
              <button onClick={() => setSelectedDay(null)} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
            </div>

            <div className="p-5 space-y-6">
              {[
                { label: data.myTeam.name, players: selectedDay.myPlayers, color: 'text-blue-400', isYou: true },
                { label: data.opponent.name, players: selectedDay.oppPlayers, color: 'text-red-400', isYou: false },
              ].map(({ label, players, color, isYou }) => (
                <div key={label}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <p className={`text-xs font-semibold uppercase tracking-wider ${color}`}>{label}</p>
                      {isYou && <span className="text-xs text-blue-400">(You)</span>}
                      {players.length > 10 && <span className="text-xs text-gray-500">top 10 count</span>}
                    </div>
                    <span className={`text-sm font-bold tabular-nums ${color}`}>
                      {Math.round(players.filter(p => p.counts).reduce((s, p) => s + p.avg, 0))}
                    </span>
                  </div>
                  {players.length === 0
                    ? <p className="text-xs text-gray-600 italic">No players active</p>
                    : (
                      <div className="space-y-2">
                        {players.map((p, i) => (
                          <div
                            key={i}
                            className={`flex items-center gap-3 ${!p.counts ? 'opacity-40' : ''} ${p.playerId && !p.isStretchAdd ? 'cursor-pointer hover:bg-gray-800 rounded-lg px-1 -mx-1' : ''}`}
                            onClick={e => p.playerId && !p.isStretchAdd && onPlayerClick(p.playerId, p.name, e.clientX, e.clientY)}
                          >
                            {p.isStretchAdd
                              ? <div className="w-8 h-8 rounded-full bg-yellow-500/20 border border-yellow-500/40 shrink-0 flex items-center justify-center text-yellow-400 text-xs font-bold">+</div>
                              : p.playerId
                                ? <img
                                    src={`https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`}
                                    alt={p.name}
                                    className="w-8 h-8 rounded-full object-cover bg-gray-800 shrink-0"
                                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                  />
                                : <div className="w-8 h-8 rounded-full bg-gray-800 shrink-0" />
                            }
                            <span className={`text-sm flex-1 truncate ${p.isStretchAdd ? 'text-yellow-400' : 'text-white'}`}>{p.name}</span>
                            <span className={`text-sm tabular-nums font-medium ${p.isStretchAdd ? 'text-yellow-400' : p.counts ? color : 'text-gray-600'}`}>
                              {Math.round(p.avg)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )
                  }
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SimulateView({ data }: { data: SimResult }) {
  const winPct = Math.round(data.winProbability * 100)
  const losePct = 100 - winPct

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">{data.n.toLocaleString()} Simulations · Season avg + schedule + injuries</p>
        <p className={`text-5xl font-bold tabular-nums ${winPct >= 50 ? 'text-green-400' : 'text-red-400'}`}>
          {winPct}%
        </p>
        <p className="text-sm text-gray-400 mt-1">chance of winning the championship</p>
      </div>

      {/* Win/lose bar */}
      <div className="flex rounded-full overflow-hidden h-4">
        <div className="bg-blue-500 transition-all" style={{ width: `${winPct}%` }} />
        <div className="bg-red-500 flex-1" />
      </div>
      <div className="flex justify-between text-xs text-gray-400 -mt-4">
        <span className="text-blue-400">{data.myTeam.name} {winPct}%</span>
        <span className="text-red-400">{losePct}% {data.opponent.name}</span>
      </div>

      {/* Score distribution histogram */}
      <div className="bg-gray-900 rounded-2xl p-4">
        <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Score Difference Distribution (You – Opponent)</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.histogram} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <XAxis dataKey="range" tick={{ fill: '#6b7280', fontSize: 10 }} interval={3} />
            <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} width={32} />
            <Tooltip
              contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
              labelStyle={{ color: '#9ca3af', fontSize: 11 }}
              formatter={(v) => [`${v} sims`, 'Count']}
            />
            <ReferenceLine x="0" stroke="#4b5563" strokeWidth={2} />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {data.histogram.map((b, i) => (
                <Cell key={i} fill={b.win ? '#3b82f6' : '#ef4444'} fillOpacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="text-xs text-gray-600 text-center mt-1">Blue = you win · Red = you lose</p>
      </div>

      {/* Percentile ranges */}
      <div className="grid grid-cols-2 gap-4">
        {[
          { team: data.myTeam, color: 'blue' },
          { team: data.opponent, color: 'red' },
        ].map(({ team, color }) => (
          <div key={team.name} className="bg-gray-900 rounded-2xl p-4">
            <p className={`text-xs font-semibold uppercase tracking-wider mb-3 text-${color}-400`}>{team.name}</p>
            <div className="space-y-2">
              {[
                { label: '90th %ile', val: team.p90, muted: true },
                { label: '75th %ile', val: team.p75, muted: false },
                { label: 'Median',    val: team.p50, muted: false },
                { label: '25th %ile', val: team.p25, muted: false },
                { label: '10th %ile', val: team.p10, muted: true },
              ].map(({ label, val, muted }) => (
                <div key={label} className="flex justify-between items-center">
                  <span className={`text-xs ${muted ? 'text-gray-600' : 'text-gray-400'}`}>{label}</span>
                  <span className={`text-sm tabular-nums font-medium ${muted ? 'text-gray-600' : 'text-white'}`}>{val}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MatchupView({ matchup }: { matchup: Matchup }) {
  const { home, away, matchupPeriodId, myTeamId } = matchup
  const myTeam = home.id === myTeamId ? home : (away ?? home)
  const oppTeam = home.id === myTeamId ? away : home
  const winning = myTeam && oppTeam ? myTeam.totalPoints > oppTeam.totalPoints : null

  return (
    <>
      <p className="text-xs text-gray-500 uppercase tracking-widest mb-6 text-center">
        Matchup Period {matchupPeriodId}
      </p>
      <div className="bg-gray-900 rounded-2xl p-6 mb-6 flex items-center justify-between">
        <ScoreTeam team={myTeam} isYou />
        <div className="text-center px-4">
          <div className="text-4xl font-bold tracking-tight tabular-nums">
            <span className="text-white">{Math.round(myTeam.totalPoints)}</span>
            <span className="text-gray-700 mx-3 text-2xl">–</span>
            <span className="text-gray-400">{oppTeam ? Math.round(oppTeam.totalPoints) : '—'}</span>
          </div>
          {winning !== null && (
            <p className={`text-xs mt-1 font-semibold ${winning ? 'text-green-400' : 'text-red-400'}`}>
              {winning ? '▲ Winning' : '▼ Losing'}
            </p>
          )}
        </div>
        {oppTeam
          ? <ScoreTeam team={oppTeam} isYou={false} />
          : <div className="w-28 text-gray-600 text-sm text-right">BYE</div>
        }
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <RosterCard team={myTeam} isYou />
        {oppTeam && <RosterCard team={oppTeam} isYou={false} />}
      </div>
    </>
  )
}


function ScoreTeam({ team, isYou }: { team: TeamData; isYou: boolean }) {
  const r = team.record
  return (
    <div className={`text-center w-28 ${isYou ? 'text-white' : 'text-gray-400'}`}>
      {isYou && <span className="text-xs text-blue-400 font-medium block mb-1">You</span>}
      <div className="font-bold text-sm uppercase tracking-wide">{team.abbrev.trim()}</div>
      <div className="text-xs text-gray-500 mt-0.5 leading-tight">{team.name}</div>
      {r && <div className="text-xs text-gray-600 mt-1">{r.wins}–{r.losses}</div>}
    </div>
  )
}

function RosterCard({ team, isYou }: { team: TeamData; isYou: boolean }) {
  // Prefer today's roster (live scores) if available, fall back to full roster
  const sortByGame = (players: Player[]) => [...players].sort((a, b) => {
    const aKey = a.gameSortKey ?? Infinity
    const bKey = b.gameSortKey ?? Infinity
    return aKey - bKey
  })
  const todayAll = (team.todayRoster ?? [])
  const todayStarters = sortByGame(todayAll.filter(p => p.position <= 12))
  const todayBench = sortByGame(todayAll.filter(p => p.position >= 13))
  const fullStarters = team.roster.filter(p => p.position <= 12)
  const fullBench = team.roster.filter(p => p.position >= 13)
  const starters = todayStarters.length > 0 ? todayStarters : fullStarters
  const bench = todayStarters.length > 0 ? todayBench : fullBench
  return (
    <div className="bg-gray-900 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
        <span className="text-sm font-semibold text-white">{team.name}</span>
        {isYou && <span className="text-xs text-blue-400">You</span>}
      </div>
      <PlayerList players={starters} />
      {bench.length > 0 && (
        <>
          <div className="px-4 py-1 text-xs text-gray-600 uppercase tracking-widest border-t border-gray-800 bg-gray-950">Bench</div>
          <PlayerList players={bench} dim />
        </>
      )}
    </div>
  )
}

function normalCDF(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.sqrt(2)
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

function adjustedWinProb(sim: SimResult, delta: number): number {
  const bins = sim.histogram
  const total = bins.reduce((s, b) => s + b.count, 0)
  if (!total) return sim.winProbability
  let mean = 0, variance = 0
  for (const b of bins) {
    const center = parseInt(b.range) + 25
    mean += center * b.count / total
  }
  for (const b of bins) {
    const center = parseInt(b.range) + 25
    variance += (center - mean) ** 2 * b.count / total
  }
  const std = Math.sqrt(variance) || 1
  return normalCDF((mean + delta) / std)
}

function OutcomeDistribution({ histogram, delta }: { histogram: SimResult['histogram']; delta: number }) {
  // Shift each bin right by delta for display; recolor based on shifted position
  const chartData = histogram.map(b => {
    const lo = parseInt(b.range) + delta
    return { range: `${lo > 0 ? '+' : ''}${Math.round(lo)}`, count: b.count, win: lo + 25 > 0 }
  })
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
        <XAxis dataKey="range" tick={{ fill: '#4b5563', fontSize: 9 }} interval={4} />
        <YAxis tick={{ fill: '#4b5563', fontSize: 9 }} width={32} />
        <Tooltip
          contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
          labelStyle={{ color: '#9ca3af', fontSize: 10 }}
          formatter={(v) => [`${v} sims`, '']}
        />
        <ReferenceLine x={chartData.find(b => parseInt(b.range) >= 0)?.range ?? '0'} stroke="#6b7280" strokeWidth={1} strokeDasharray="3 3" />
        <Bar dataKey="count" radius={[2, 2, 0, 0]}>
          {chartData.map((b, i) => (
            <Cell key={i} fill={b.win ? '#3b82f6' : '#ef4444'} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function FreeAgentsView({ data, sim, selectedDrops, selectedAdds, onToggleDrop, onToggleAdd }: {
  data: FreeAgentsData
  sim: SimResult | null
  selectedDrops: Set<number>
  selectedAdds: Set<number>
  onToggleDrop: (id: number) => void
  onToggleAdd: (id: number) => void
}) {
  const allPlayers = [...data.dropCandidates, ...data.players]
  const maxTotal = Math.max(...allPlayers.map(p => p.projectedTotal), 1)
  const rows = Math.max(data.dropCandidates.length, data.players.length)

  const delta = [...selectedAdds].reduce((s, id) => {
    const p = data.players.find(p => p.playerId === id)
    return s + (p?.projectedTotal ?? 0)
  }, 0) - [...selectedDrops].reduce((s, id) => {
    const p = data.dropCandidates.find(p => p.playerId === id)
    return s + (p?.projectedTotal ?? 0)
  }, 0)

  const baseWinPct = sim ? Math.round(sim.winProbability * 100) : null
  const adjWinPct = sim && (selectedDrops.size > 0 || selectedAdds.size > 0)
    ? Math.round(adjustedWinProb(sim, delta) * 100)
    : baseWinPct
  const winDiff = adjWinPct !== null && baseWinPct !== null ? adjWinPct - baseWinPct : 0

  return (
    <div>
      {/* Win probability box */}
      {adjWinPct !== null && sim && (
        <div className="bg-gray-900 rounded-2xl p-5 mb-5">
          <div className="text-center mb-4">
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Win Probability</p>
            <p className={`text-6xl font-bold tabular-nums ${adjWinPct >= 50 ? 'text-green-400' : 'text-red-400'}`}>
              {adjWinPct}%
            </p>
            {selectedDrops.size > 0 || selectedAdds.size > 0 ? (
              <p className={`text-sm mt-2 font-medium ${winDiff > 0 ? 'text-green-400' : winDiff < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                {winDiff > 0 ? `+${winDiff}%` : winDiff < 0 ? `${winDiff}%` : 'no change'} from {selectedDrops.size} drop{selectedDrops.size !== 1 ? 's' : ''} / {selectedAdds.size} add{selectedAdds.size !== 1 ? 's' : ''}
              </p>
            ) : (
              <p className="text-xs text-gray-600 mt-1">check boxes to simulate trades</p>
            )}
          </div>
          <OutcomeDistribution histogram={sim.histogram} delta={delta} />
        </div>
      )}

      <div className="flex justify-between items-end px-1 mb-3">
        <p className="text-xs text-gray-500">
          Schedule-adjusted pts through Apr 5
          {data.scheduleAdjusted && <span className="text-green-500"> · opp strength applied</span>}
        </p>
        <p className="text-xs text-gray-600">{data.remainingDates.length} days left</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <p className="text-xs text-red-400 uppercase tracking-wider font-semibold">Drop (lowest first)</p>
        <p className="text-xs text-green-400 uppercase tracking-wider font-semibold">Add (highest first)</p>

        {Array.from({ length: rows }).map((_, i) => (
          <>
            <div key={`drop-${i}`}>
              {data.dropCandidates[i]
                ? <CompactPlayerRow p={data.dropCandidates[i]} maxTotal={maxTotal} scheduleAdjusted={data.scheduleAdjusted}
                    selected={selectedDrops.has(data.dropCandidates[i].playerId)}
                    onToggle={() => onToggleDrop(data.dropCandidates[i].playerId)} />
                : <div />}
            </div>
            <div key={`add-${i}`}>
              {data.players[i]
                ? <CompactPlayerRow p={data.players[i]} maxTotal={maxTotal} scheduleAdjusted={data.scheduleAdjusted}
                    selected={selectedAdds.has(data.players[i].playerId)}
                    onToggle={() => onToggleAdd(data.players[i].playerId)} />
                : <div />}
            </div>
          </>
        ))}
      </div>
    </div>
  )
}

function CompactPlayerRow({ p, maxTotal, scheduleAdjusted, selected = false, onToggle }: {
  p: FreeAgent; maxTotal: number; scheduleAdjusted: boolean; selected?: boolean; onToggle?: () => void
}) {
  const onPlayerClick = useContext(PlayerClickContext)
  const baseTotal = p.avg * p.gamesLeft
  const adjDiff = p.projectedTotal - baseTotal
  return (
    <div className={`bg-gray-900 rounded-xl p-3 flex items-center gap-2 transition-colors ${selected ? 'ring-2 ring-blue-500 bg-gray-800' : 'hover:bg-gray-800'}`}>
      <div className="cursor-pointer shrink-0" onClick={onToggle}>
        <input type="checkbox" checked={selected} onChange={() => {}} className="accent-blue-500 pointer-events-none" />
      </div>
      <div
        className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
        onClick={e => onPlayerClick(p.playerId, p.name, e.clientX, e.clientY)}
      >
        <img
          src={`https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`}
          alt={p.name}
          className="w-8 h-8 rounded-full object-cover bg-gray-800 shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-xs font-semibold text-white truncate">{p.name}</span>
            {p.position && <span className="text-xs text-gray-500 shrink-0 bg-gray-700 px-1 rounded">{p.position}</span>}
            <span className="text-xs text-gray-600 shrink-0">{p.proTeam}</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-1">
            <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${(p.projectedTotal / maxTotal) * 100}%` }} />
          </div>
        </div>
      </div>
      <div className="text-right shrink-0 cursor-pointer" onClick={onToggle}>
        <p className="text-sm font-bold tabular-nums text-blue-400">{p.projectedTotal}</p>
        <p className="text-xs text-gray-600">{p.avg}×{p.gamesLeft}g</p>
        {scheduleAdjusted && adjDiff !== 0 && (
          <p className={`text-xs tabular-nums ${adjDiff > 0 ? 'text-green-500' : 'text-red-400'}`}>
            {adjDiff > 0 ? '+' : ''}{Math.round(adjDiff)}
          </p>
        )}
      </div>
    </div>
  )
}

function PlayerList({ players, dim = false, showGame = false }: { players: Player[]; dim?: boolean; showGame?: boolean }) {
  const onPlayerClick = useContext(PlayerClickContext)
  return (
    <div>
      {players.map((p, i) => (
        <div
          key={i}
          className={`flex items-center justify-between px-4 py-2 border-b border-gray-800 last:border-0 ${dim ? 'opacity-50' : ''} ${p.playerId ? 'cursor-pointer hover:bg-gray-800' : ''}`}
          onClick={e => p.playerId && onPlayerClick(p.playerId, p.name, e.clientX, e.clientY)}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-xs text-gray-500 w-8 shrink-0">{SLOT_LABELS[p.position] ?? '?'}</span>
            {p.playerId
              ? <img
                  src={`https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`}
                  alt={p.name}
                  className="w-8 h-8 rounded-full object-cover bg-gray-800 shrink-0"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              : <div className="w-8 h-8 rounded-full bg-gray-800 shrink-0" />
            }
            <div className="min-w-0">
              <span className="text-sm text-white truncate block">{p.name}</span>
              {p.opponent && (
                <span className="text-xs text-gray-500">
                  {p.proTeamAbbrev} vs {p.opponent}
                  {p.gameStatus ? <span className="text-yellow-400 ml-1">{p.gameStatus}</span>
                    : p.gameTime ? <span className="ml-1">{p.gameTime}</span> : null}
                  {p.broadcast && <span className="text-gray-600 ml-1">· {p.broadcast}</span>}
                </span>
              )}
            </div>
            {p.injuryStatus && <span className="text-xs text-red-400 shrink-0">{p.injuryStatus}</span>}
          </div>
          <div className="ml-2 shrink-0 text-right">
            {showGame
              ? <span className={`text-xs font-medium ${p.hasGame ? 'text-green-400' : 'text-gray-600'}`}>
                  {p.hasGame ? 'plays' : 'off'}
                </span>
              : <span className={`text-sm tabular-nums font-medium ${p.stats && p.stats > 0 ? 'text-green-400' : 'text-gray-600'}`}>
                  {typeof p.stats === 'number' ? Math.round(p.stats) : '—'}
                </span>
            }
          </div>
        </div>
      ))}
    </div>
  )
}

function VsAvgPlayerRow({ p, maxTotal, selected, onToggle }: {
  p: VsAvgPlayer; maxTotal: number; selected: boolean; onToggle: () => void
}) {
  const onPlayerClick = useContext(PlayerClickContext)
  const adjDiff = p.expectedTotal - Math.round(p.seasonAvg) * p.games.length
  return (
    <div className={`bg-gray-900 rounded-xl p-3 flex items-center gap-2 transition-colors ${selected ? 'ring-2 ring-blue-500 bg-gray-800' : 'hover:bg-gray-800'}`}>
      <div className="cursor-pointer shrink-0" onClick={onToggle}>
        <input type="checkbox" checked={selected} onChange={() => {}} className="accent-blue-500 pointer-events-none" />
      </div>
      <div className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" onClick={e => onPlayerClick(p.playerId, p.name, e.clientX, e.clientY)}>
        <img
          src={`https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`}
          alt={p.name}
          className="w-8 h-8 rounded-full object-cover bg-gray-800 shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-xs font-semibold text-white truncate">{p.name}</span>
            {p.position && <span className="text-xs text-gray-500 shrink-0 bg-gray-700 px-1 rounded">{p.position}</span>}
            <span className="text-xs text-gray-600 shrink-0">{p.proTeam}</span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-1">
            <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${(p.expectedTotal / maxTotal) * 100}%` }} />
          </div>
          {/* Game chips */}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {p.games.map((g, i) => (
              <span key={i} className={`text-xs px-1 rounded tabular-nums ${g.usedFallback ? 'text-gray-600' : 'text-gray-400'}`}>
                {g.atVs}{g.oppAbbr} <span className={g.usedFallback ? 'text-gray-500' : 'text-blue-300 font-semibold'}>{g.expectedFPTS}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0 cursor-pointer" onClick={onToggle}>
        <p className="text-sm font-bold tabular-nums text-blue-400">{p.expectedTotal}</p>
        <p className="text-xs text-gray-600">{p.seasonAvg}avg×{p.games.length}g</p>
        {adjDiff !== 0 && (
          <p className={`text-xs tabular-nums ${adjDiff > 0 ? 'text-green-500' : 'text-red-400'}`}>
            {adjDiff > 0 ? '+' : ''}{adjDiff}
          </p>
        )}
      </div>
    </div>
  )
}

function VsAvgView({ data, sim, selectedDrops, selectedAdds, onToggleDrop, onToggleAdd }: {
  data: VsAvgData
  sim: SimResult | null
  selectedDrops: Set<number>
  selectedAdds: Set<number>
  onToggleDrop: (id: number) => void
  onToggleAdd: (id: number) => void
}) {
  const allPlayers = [...data.myPlayers, ...data.faPlayers]
  const maxTotal = Math.max(...allPlayers.map(p => p.expectedTotal), 1)
  const rows = Math.max(data.myPlayers.length, data.faPlayers.length)

  const delta = [...selectedAdds].reduce((s, id) => {
    const p = data.faPlayers.find(p => p.playerId === id)
    return s + (p?.expectedTotal ?? 0)
  }, 0) - [...selectedDrops].reduce((s, id) => {
    const p = data.myPlayers.find(p => p.playerId === id)
    return s + (p?.expectedTotal ?? 0)
  }, 0)

  const baseWinPct = sim ? Math.round(sim.winProbability * 100) : null
  const adjWinPct = sim && (selectedDrops.size > 0 || selectedAdds.size > 0)
    ? Math.round(adjustedWinProb(sim, delta) * 100)
    : baseWinPct
  const winDiff = adjWinPct !== null && baseWinPct !== null ? adjWinPct - baseWinPct : 0

  return (
    <div>
      {adjWinPct !== null && sim && (
        <div className="bg-gray-900 rounded-2xl p-5 mb-5">
          <div className="text-center mb-4">
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Win Probability</p>
            <p className={`text-6xl font-bold tabular-nums ${adjWinPct >= 50 ? 'text-green-400' : 'text-red-400'}`}>{adjWinPct}%</p>
            {selectedDrops.size > 0 || selectedAdds.size > 0 ? (
              <p className={`text-sm mt-2 font-medium ${winDiff > 0 ? 'text-green-400' : winDiff < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                {winDiff > 0 ? `+${winDiff}%` : winDiff < 0 ? `${winDiff}%` : 'no change'} from {selectedDrops.size} drop{selectedDrops.size !== 1 ? 's' : ''} / {selectedAdds.size} add{selectedAdds.size !== 1 ? 's' : ''}
              </p>
            ) : (
              <p className="text-xs text-gray-600 mt-1">check boxes to simulate trades · using vs-opponent avg</p>
            )}
          </div>
          <OutcomeDistribution histogram={sim.histogram} delta={delta} />
        </div>
      )}

      <div className="flex justify-between items-end px-1 mb-3">
        <p className="text-xs text-gray-500">Expected pts · historical avg vs each remaining opponent</p>
        <p className="text-xs text-gray-600">{data.myPlayers.reduce((s, p) => s + p.games.length, 0)} total games left</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <p className="text-xs text-red-400 uppercase tracking-wider font-semibold">Drop (lowest first)</p>
        <p className="text-xs text-green-400 uppercase tracking-wider font-semibold">Add (highest first)</p>
        {Array.from({ length: rows }).map((_, i) => (
          <>
            <div key={`drop-${i}`}>
              {data.myPlayers[i] && (
                <VsAvgPlayerRow p={data.myPlayers[i]} maxTotal={maxTotal}
                  selected={selectedDrops.has(data.myPlayers[i].playerId)}
                  onToggle={() => onToggleDrop(data.myPlayers[i].playerId)} />
              )}
            </div>
            <div key={`add-${i}`}>
              {data.faPlayers[i] && (
                <VsAvgPlayerRow p={data.faPlayers[i]} maxTotal={maxTotal}
                  selected={selectedAdds.has(data.faPlayers[i].playerId)}
                  onToggle={() => onToggleAdd(data.faPlayers[i].playerId)} />
              )}
            </div>
          </>
        ))}
      </div>
    </div>
  )
}

// ── Stat labels we care about and in what order ────────────────────────────
const STAT_ORDER = ['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FG%', '3P%', 'FT%', 'MIN', 'GP']

function PlayerStatsModal({ playerId, name, x, y, onClose }: { playerId: number; name: string; x: number; y: number; onClose: () => void }) {
  const [stats, setStats] = useState<PlayerStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)

  useEffect(() => {
    setLoading(true); setErr(false); setStats(null); setStatsOpen(false)
    fetch(`/api/player/${playerId}`)
      .then(r => r.json())
      .then(d => { if (d.error) setErr(true); else setStats(d) })
      .catch(() => setErr(true))
      .finally(() => setLoading(false))
  }, [playerId])

  const buildRows = (labels: string[], values: string[]) => {
    const map: Record<string, string> = {}
    labels.forEach((l, i) => { map[l] = values[i] ?? '—' })
    return STAT_ORDER.filter(l => map[l] !== undefined).map(l => ({ label: l, value: map[l] }))
  }

  const seasonRows = stats ? buildRows(stats.statLabels, stats.season) : []
  const l10Rows = stats ? buildRows(stats.statLabels, stats.l10) : []
  const BOX_COLS = ['FPTS', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', '3PM'] as const

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)' }} onClick={onClose} />
      <div
        style={{
          position: 'fixed',
          top: Math.min(y, window.innerHeight - 80),
          left: Math.min(Math.max(x - 180, 8), window.innerWidth - 456),
          width: 'min(calc(100vw - 2rem), 28rem)',
          maxHeight: `${window.innerHeight - Math.min(y, window.innerHeight - 80) - 16}px`,
          overflowY: 'auto',
          zIndex: 201,
        }}
        className="bg-gray-900 rounded-3xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center gap-4 rounded-t-3xl">
          <img
            src={`https://a.espncdn.com/i/headshots/nba/players/full/${playerId}.png`}
            alt={name}
            className="w-14 h-14 rounded-full object-cover bg-gray-800 shrink-0"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-base text-white truncate">{stats?.name || name}</p>
            {stats && (
              <p className="text-sm text-gray-400">
                {stats.position} · {stats.proTeam}
                {stats.injuryStatus && stats.injuryStatus !== 'ACTIVE' && (
                  <span className="text-red-400 ml-2">{stats.injuryStatus}</span>
                )}
              </p>
            )}
            {stats?.percentOwned != null && (
              <p className="text-xs text-gray-600">{stats.percentOwned}% owned</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-2xl leading-none shrink-0">×</button>
        </div>

        {loading && <div className="text-center text-gray-500 text-sm py-16">Loading stats...</div>}
        {err && <div className="text-center text-red-400 text-sm py-16">Could not load stats</div>}

        {stats && !loading && (
          <div className="p-5 space-y-4">
            {/* Fantasy pts */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Fantasy Avg', sub: 'Season', value: stats.fantasyAvg != null ? stats.fantasyAvg.toFixed(1) : '—' },
                { label: 'Fantasy Avg', sub: 'Recent (L7)', value: stats.fantasyRecent != null ? stats.fantasyRecent.toFixed(1) : '—' },
              ].map(({ label, sub, value }) => (
                <div key={sub} className="bg-gray-800 rounded-2xl p-3 text-center">
                  <p className="text-2xl font-bold text-blue-400 tabular-nums">{value}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{label}</p>
                  <p className="text-xs text-gray-600">{sub}</p>
                </div>
              ))}
            </div>

            {/* Stats table — collapsible */}
            {seasonRows.length > 0 && (
              <div className="bg-gray-800 rounded-2xl overflow-hidden">
                <button
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                  onClick={() => setStatsOpen(o => !o)}
                >
                  <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Season / L10 Stats</span>
                  <span className="text-gray-500 text-sm">{statsOpen ? '▲' : '▼'}</span>
                </button>
                {statsOpen && (
                  <>
                    <div className="grid grid-cols-3 px-4 pb-1 text-xs text-gray-500 uppercase tracking-wider border-t border-gray-700">
                      <span></span>
                      <span className="text-center">Season</span>
                      <span className="text-center">L10</span>
                    </div>
                    {seasonRows.map(({ label, value }, i) => {
                      const l10val = l10Rows.find(r => r.label === label)?.value ?? '—'
                      return (
                        <div key={label} className={`grid grid-cols-3 px-4 py-2 text-sm ${i % 2 === 0 ? '' : 'bg-gray-900/40'}`}>
                          <span className="text-gray-400 font-medium">{label}</span>
                          <span className="text-center text-white tabular-nums">{value}</span>
                          <span className="text-center text-gray-300 tabular-nums">{l10val}</span>
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            )}

            {/* Last 5 games — player box stats */}
            {stats.last5Games.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Last 5 Games</p>
                <div className="bg-gray-800 rounded-2xl overflow-hidden">
                  {/* Column headers */}
                  <div className="grid px-3 py-2 border-b border-gray-700 text-xs text-gray-500" style={{ gridTemplateColumns: '3.5rem 2rem ' + BOX_COLS.map(() => '1fr').join(' ') }}>
                    <span></span>
                    <span></span>
                    {BOX_COLS.map(c => <span key={c} className="text-center">{c}</span>)}
                  </div>
                  {stats.last5Games.map((g, i) => {
                    const dateStr = g.date
                      ? new Date(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : '—'
                    return (
                      <div
                        key={i}
                        className={`grid items-center px-3 py-2 text-xs ${i < stats.last5Games.length - 1 ? 'border-b border-gray-700' : ''}`}
                        style={{ gridTemplateColumns: '3.5rem 2rem ' + BOX_COLS.map(() => '1fr').join(' ') }}
                      >
                        <span className="text-gray-500">{dateStr}</span>
                        <span className={`font-semibold ${g.result === 'W' ? 'text-green-400' : 'text-red-400'}`}>{g.result}</span>
                        {BOX_COLS.map(c => (
                          <span key={c} className={`text-center tabular-nums ${c === 'FPTS' ? 'font-bold text-blue-300' : 'text-white'}`}>{g[c] ?? '—'}</span>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Upcoming games through Apr 5 */}
            {stats.upcomingGames?.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Remaining Games</p>
                <div className="bg-gray-800 rounded-2xl overflow-hidden">
                  {stats.upcomingGames.map((g, i) => {
                    const dateStr = new Date(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    return (
                      <div key={i} className={i < stats.upcomingGames.length - 1 ? 'border-b border-gray-700' : ''}>
                        {/* Game header row */}
                        <div className="flex items-center px-4 py-2 text-sm">
                          <span className="text-gray-400 w-14">{dateStr}</span>
                          <span className="font-semibold text-white flex-1">{g.label}</span>
                          <span className="text-gray-500 text-xs w-12 text-right">{g.oppRecord}</span>
                          {g.broadcast && <span className="text-gray-500 text-xs w-14 text-right ml-2">{g.broadcast}</span>}
                        </div>
                        {/* Prior games vs this opponent */}
                        {g.history.length > 0 && (
                          <div className="px-4 pb-2 flex gap-2 flex-wrap">
                            {g.history.map((h, j) => {
                              const hDate = new Date(h.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                              return (
                                <div key={j} className="flex items-center gap-1 bg-gray-700 rounded-lg px-2 py-1 text-xs">
                                  <span className="text-gray-400">{hDate}</span>
                                  <span className={h.result === 'W' ? 'text-green-400' : 'text-red-400'}>{h.result}</span>
                                  <span className="font-bold text-blue-300">{h.FPTS}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>,
    document.body
  )
}
