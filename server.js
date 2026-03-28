require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const express = require('express')
const cors = require('cors')
const path = require('path')
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))

const app = express()
app.use(cors())

const LEAGUE_ID = process.env.LEAGUE_ID
const ESPN_S2 = process.env.ESPN_S2
const SWID = process.env.SWID
const SEASON = 2026

const headers = {
  Cookie: `espn_s2=${ESPN_S2}; SWID=${SWID}`,
  'Accept': 'application/json',
  'x-fantasy-source': 'kona',
}

app.get('/api/matchup', async (req, res) => {
  try {
    // Get league info to find current scoring period and teams
    const leagueRes = await fetch(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mMatchup&view=mMatchupScore&view=mLiveScoring&view=mTeam&view=mRoster&view=mSettings`,
      { headers }
    )

    if (!leagueRes.ok) {
      return res.status(leagueRes.status).json({ error: 'ESPN API error', status: leagueRes.status })
    }

    const data = await leagueRes.json()

    const scoringPeriodId = data.scoringPeriodId
    const matchupPeriodId = data.status?.currentMatchupPeriod ?? 1

    // Find user's team by SWID (ESPN stores it with curly braces)
    const myTeam = data.teams?.find(t =>
      t.primaryOwner === SWID ||
      (t.owners && t.owners.includes(SWID))
    )

    if (!myTeam) {
      return res.status(404).json({ error: 'Could not find your team. Check SWID.' })
    }

    // Find current matchup for user's team
    const myMatchup = data.schedule?.find(m =>
      m.matchupPeriodId === matchupPeriodId &&
      (m.home?.teamId === myTeam.id || m.away?.teamId === myTeam.id)
    )

    if (!myMatchup) {
      return res.status(404).json({ error: 'No current matchup found.' })
    }

    // Build team lookup
    const teamMap = {}
    for (const t of data.teams ?? []) {
      teamMap[t.id] = {
        id: t.id,
        name: t.name ?? t.abbrev,
        abbrev: t.abbrev,
        logo: t.logo,
        record: t.record?.overall,
        roster: t.roster?.entries?.map(e => ({
          name: e.playerPoolEntry?.playerProfile?.fullName ?? e.playerPoolEntry?.player?.fullName,
          playerId: e.playerId,
          position: e.lineupSlotId,
          proTeam: e.playerPoolEntry?.player?.proTeamId,
          injuryStatus: e.playerPoolEntry?.player?.injured ? e.playerPoolEntry?.player?.injuryStatus : null,
          stats: e.playerPoolEntry?.playerProfile?.stats ?? e.playerPoolEntry?.appliedStatTotal,
        })) ?? [],
      }
    }

    const home = teamMap[myMatchup.home?.teamId]
    const away = teamMap[myMatchup.away?.teamId]

    const liveScore = (side) => side?.totalPointsLive ?? side?.totalPoints ?? 0

    // Fetch today's scoreboard for opponent + tipoff info
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const sbRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${todayStr}`
    ).then(r => r.json()).catch(() => ({ events: [] }))

    // Build abbrev → { opponent, time, broadcast, status } map
    const gameByTeam = {}
    for (const ev of sbRes.events ?? []) {
      const comp = (ev.competitions ?? [])[0]
      if (!comp) continue
      const comps = comp.competitors ?? []
      if (comps.length !== 2) continue
      const [a, b] = comps
      const abbA = normAbbrev(a.team.abbreviation), abbB = normAbbrev(b.team.abbreviation)
      const home = normAbbrev(comps.find(c => c.homeAway === 'home')?.team?.abbreviation ?? abbA)
      const away = normAbbrev(comps.find(c => c.homeAway === 'away')?.team?.abbreviation ?? abbB)
      const gameDate = new Date(comp.date ?? ev.date)
      const gameTime = gameDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })
      const gameSortKey = gameDate.getTime()
      const broadcast = comp.broadcast ?? (comp.geoBroadcasts ?? [])[0]?.media?.shortName ?? null
      const statusState = comp.status?.type?.state ?? 'pre'
      const statusDesc = comp.status?.type?.description ?? ''
      const clock = comp.status?.displayClock ?? ''
      const period = comp.status?.period ?? 0
      const gameInfo = { home, away, gameTime, gameSortKey, broadcast, statusState, statusDesc, clock, period }
      gameByTeam[abbA] = gameInfo
      gameByTeam[abbB] = gameInfo
    }

    const parseTodayRoster = (matchupSide) => {
      return (matchupSide?.rosterForCurrentScoringPeriod?.entries ?? []).map(e => {
        const player = e.playerPoolEntry?.player ?? {}
        const abbrev = PRO_TEAM_ABBREV[player.proTeamId] ?? null
        const gameInfo = abbrev ? gameByTeam[abbrev] : null
        let opponent = null, gameTime = null, gameSortKey = null, broadcast = null, gameStatus = null
        if (gameInfo) {
          opponent = gameInfo.home === abbrev ? gameInfo.away : gameInfo.home
          gameTime = gameInfo.gameTime
          gameSortKey = gameInfo.gameSortKey
          broadcast = gameInfo.broadcast
          if (gameInfo.statusState === 'in') {
            gameStatus = `Q${gameInfo.period} ${gameInfo.clock}`
          } else if (gameInfo.statusState === 'post') {
            gameStatus = 'Final'
          }
        }
        return {
          name: player.fullName ?? e.playerPoolEntry?.playerProfile?.fullName,
          playerId: e.playerId,
          position: e.lineupSlotId,
          injuryStatus: player.injured ? player.injuryStatus : null,
          stats: e.playerPoolEntry?.appliedStatTotal ?? null,
          proTeamAbbrev: abbrev,
          opponent,
          gameTime,
          gameSortKey,
          broadcast,
          gameStatus,
        }
      })
    }

    res.json({
      matchupPeriodId,
      scoringPeriodId,
      myTeamId: myTeam.id,
      home: {
        ...home,
        totalPoints: liveScore(myMatchup.home),
        todayRoster: parseTodayRoster(myMatchup.home),
      },
      away: away ? {
        ...away,
        totalPoints: liveScore(myMatchup.away),
        todayRoster: parseTodayRoster(myMatchup.away),
      } : null,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/tomorrow', async (req, res) => {
  try {
    // Get current scoring period first
    const infoRes = await fetch(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mSettings`,
      { headers }
    )
    const info = await infoRes.json()
    const tomorrowPeriod = info.scoringPeriodId + 1

    // Fetch roster for tomorrow's scoring period
    const rosterRes = await fetch(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&view=mTeam&scoringPeriodId=${tomorrowPeriod}`,
      { headers }
    )
    if (!rosterRes.ok) {
      return res.status(rosterRes.status).json({ error: 'ESPN API error' })
    }
    const data = await rosterRes.json()

    const myTeam = data.teams?.find(t =>
      t.primaryOwner === SWID || (t.owners && t.owners.includes(SWID))
    )
    if (!myTeam) return res.status(404).json({ error: 'Team not found' })

    const players = myTeam.roster?.entries?.map(e => ({
      name: e.playerPoolEntry?.player?.fullName,
      playerId: e.playerId,
      position: e.lineupSlotId,
      injuryStatus: e.playerPoolEntry?.player?.injured ? e.playerPoolEntry?.player?.injuryStatus : null,
      hasGame: e.playerPoolEntry?.player?.proTeamId != null,
      proTeamId: e.playerPoolEntry?.player?.proTeamId,
    })) ?? []

    res.json({
      scoringPeriodId: tomorrowPeriod,
      teamName: myTeam.name ?? myTeam.abbrev,
      players,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Manual overrides — players added/cleared outside ESPN API sync
const MY_TEAM_OVERRIDES = []

// Players dropped — exclude from all roster calculations
const MY_TEAM_REMOVALS = new Set([])

// ESPN fantasy proTeamId matches ESPN site team IDs exactly
const PRO_TEAM_ABBREV = {
  1:'ATL',2:'BOS',3:'NO',4:'CHI',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GS',10:'HOU',
  11:'IND',12:'LAC',13:'LAL',14:'MIA',15:'MIL',16:'MIN',17:'BKN',18:'NY',19:'ORL',
  20:'PHI',21:'PHX',22:'POR',23:'SAC',24:'SA',25:'OKC',26:'UTAH',27:'WSH',28:'TOR',
  29:'MEM',30:'CHA'
}
// Reverse map: abbreviation → proTeamId (for resolving per-game team IDs for traded players)
const ABBREV_TO_TEAM_ID = Object.fromEntries(Object.entries(PRO_TEAM_ABBREV).map(([id, abbr]) => [abbr, parseInt(id)]))

// ESPN public sports API uses different abbreviations than ESPN fantasy for some teams
// Normalize public API abbreviations to match PRO_TEAM_ABBREV keys used throughout the app
const PUBLIC_TO_FANTASY_ABBREV = { GSW: 'GS', NOP: 'NO', UTA: 'UTAH', SAS: 'SA', NYK: 'NY' }
const normAbbrev = (abbr) => PUBLIC_TO_FANTASY_ABBREV[abbr] ?? abbr

const POSITION_MAP = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' }
const SLOT_POSITION_MAP = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'PG', 6: 'SG', 7: 'SF', 8: 'PF', 9: 'C' }

function getPlayerPositions(player) {
  const slots = player?.eligibleSlots ?? []
  const positions = [...new Set(slots.filter(s => s <= 4).map(s => SLOT_POSITION_MAP[s]).filter(Boolean))]
  return positions.length ? positions.join('/') : (POSITION_MAP[player?.defaultPositionId] ?? '?')
}

function getPlayerAvg(player) {
  const stats = player?.stats ?? []
  const seasonStat = stats.find(s =>
    s.externalId === '2026' && s.statSplitTypeId === 0 && s.statSourceId === 0
  )
  return seasonStat?.appliedAverage ?? 0
}

function getPlayerRecentAvg(player) {
  const stats = player?.stats ?? []
  // statSplitTypeId=1 = last 7 days (best proxy for last 5 games)
  const recentStat = stats.find(s => s.statSplitTypeId === 1 && s.statSourceId === 0)
  return recentStat?.appliedAverage ?? getPlayerAvg(player)
}

async function getScheduleOnDate(dateStr) {
  // Returns { abbrevs: Set, matchups: [{home, away}] }
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`
    )
    const data = await res.json()
    const abbrevs = new Set()
    const matchups = []
    for (const event of data.events ?? []) {
      for (const comp of event.competitions ?? []) {
        const teams = (comp.competitors ?? []).map(c => normAbbrev(c.team.abbreviation))
        if (teams.length === 2) {
          abbrevs.add(teams[0])
          abbrevs.add(teams[1])
          matchups.push({ home: teams[0], away: teams[1] })
        }
      }
    }
    return { abbrevs, matchups }
  } catch {
    return { abbrevs: new Set(), matchups: [] }
  }
}

async function getPlayingTeamsOnDate(dateStr) {
  return (await getScheduleOnDate(dateStr)).abbrevs
}

// Fetch opponent PPG allowed for all teams — used to adjust projections by schedule difficulty
let defRatingsCache = null
let defRatingsCacheTime = 0

async function getTeamDefRatings() {
  if (defRatingsCache && Date.now() - defRatingsCacheTime < 3600000) return defRatingsCache
  try {
    // Compute opponent PPG from last 14 days of actual game results
    const today = new Date()
    const dates = []
    for (let i = 1; i <= 14; i++) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''))
    }

    const scoreboards = await Promise.all(
      dates.map(d =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}`)
          .then(r => r.json()).catch(() => null)
      )
    )

    // ptsAllowed[abbrev] = [pts, pts, ...]
    const ptsAllowed = {}
    for (const data of scoreboards) {
      if (!data) continue
      for (const event of data.events ?? []) {
        for (const comp of event.competitions ?? []) {
          const competitors = comp.competitors ?? []
          if (competitors.length !== 2) continue
          const [a, b] = competitors
          const abbrevA = normAbbrev(a.team.abbreviation)
          const abbrevB = normAbbrev(b.team.abbreviation)
          const scoreA = parseFloat(a.score ?? 0)
          const scoreB = parseFloat(b.score ?? 0)
          if (!scoreA && !scoreB) continue
          ;(ptsAllowed[abbrevA] = ptsAllowed[abbrevA] ?? []).push(scoreB)
          ;(ptsAllowed[abbrevB] = ptsAllowed[abbrevB] ?? []).push(scoreA)
        }
      }
    }

    const ratings = {}
    for (const [abbrev, pts] of Object.entries(ptsAllowed)) {
      if (pts.length > 0) ratings[abbrev] = pts.reduce((s, v) => s + v, 0) / pts.length
    }

    console.log('DEF RATINGS from last 14 days:', Object.keys(ratings).length, 'teams')
    defRatingsCache = ratings
    defRatingsCacheTime = Date.now()
    return ratings
  } catch (e) {
    console.error('DEF RATINGS error:', e.message)
    return {}
  }
}

function getActivePlayers(rosterEntries, playingAbbrevs, isMyTeam = false, extraPlayers = []) {
  const active = rosterEntries
    .filter(e => {
      if (e.lineupSlotId === 16 || e.lineupSlotId === 17) return false
      if (MY_TEAM_REMOVALS.has(e.playerId)) return false
      const abbrev = PRO_TEAM_ABBREV[e.playerPoolEntry?.player?.proTeamId]
      return abbrev && playingAbbrevs.has(abbrev)
    })
    .map(e => ({
      name: e.playerPoolEntry?.player?.fullName,
      playerId: e.playerId,
      avg: getPlayerAvg(e.playerPoolEntry?.player),
    }))

  if (isMyTeam) {
    for (const o of MY_TEAM_OVERRIDES) {
      const abbrev = PRO_TEAM_ABBREV[o.proTeamId]
      if (abbrev && playingAbbrevs.has(abbrev) && !active.find(p => p.playerId === o.playerId))
        active.push({ name: o.name, playerId: o.playerId, avg: o.avg, isStretchAdd: false })
    }
    active.push(...extraPlayers)
  }

  active.sort((a, b) => b.avg - a.avg)
  return active.map((p, i) => ({ ...p, counts: i < 10, isStretchAdd: p.isStretchAdd ?? false }))
}

function projectDailyPoints(rosterEntries, playingAbbrevs) {
  const players = getActivePlayers(rosterEntries, playingAbbrevs)
  return players.filter(p => p.counts).reduce((sum, p) => sum + p.avg, 0)
}

// Shared data loader for projection + simulation
async function loadMatchupData() {
  const leagueRes = await fetch(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mMatchup&view=mMatchupScore&view=mLiveScoring&view=mTeam&view=mRoster`,
    { headers }
  )
  if (!leagueRes.ok) throw new Error(`ESPN API error ${leagueRes.status}`)
  const data = await leagueRes.json()

  const matchupPeriodId = data.status?.currentMatchupPeriod ?? 1
  const myTeam = data.teams?.find(t =>
    t.primaryOwner === SWID || (t.owners && t.owners.includes(SWID))
  )
  if (!myTeam) throw new Error('Team not found')

  const myMatchup = data.schedule?.find(m =>
    m.matchupPeriodId === matchupPeriodId &&
    (m.home?.teamId === myTeam.id || m.away?.teamId === myTeam.id)
  )
  if (!myMatchup) throw new Error('No matchup found')

  const oppTeamId = myMatchup.home?.teamId === myTeam.id
    ? myMatchup.away?.teamId : myMatchup.home?.teamId
  const oppTeam = data.teams?.find(t => t.id === oppTeamId)

  const liveScore = s => s?.totalPointsLive ?? s?.totalPoints ?? 0
  const myCurrentScore = liveScore(myMatchup.home?.teamId === myTeam.id ? myMatchup.home : myMatchup.away)
  const oppCurrentScore = liveScore(myMatchup.home?.teamId === myTeam.id ? myMatchup.away : myMatchup.home)

  const endDate = new Date('2026-04-05T23:59:59')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dates = []
  for (const cur = new Date(today); cur <= endDate; cur.setDate(cur.getDate() + 1))
    dates.push(new Date(cur))

  const futureDates = dates.slice(1)
  const schedules = await Promise.all(
    futureDates.map(d => getPlayingTeamsOnDate(d.toISOString().slice(0, 10).replace(/-/g, '')))
  )

  const myRoster = myTeam.roster?.entries ?? []
  const oppRoster = oppTeam?.roster?.entries ?? []

  // ── Stretch-run replacements ──────────────────────────────────────────────
  const STRETCH_DATES = new Set(['2026-04-03', '2026-04-04', '2026-04-05'])
  const MAX_STRETCH_ADDS = 5
  const STRETCH_AVG = 25

  // Map futureDateIndex -> stretchSlotIndex (0/1/2)
  const stretchIndices = futureDates.reduce((acc, d, i) => {
    if (STRETCH_DATES.has(d.toISOString().slice(0, 10))) acc.push(i)
    return acc
  }, [])

  // For each stretch day, find which my-roster players are inactive
  const playerDropDays = new Map() // playerId -> { name, stretchSlots: [0|1|2] }
  for (let si = 0; si < stretchIndices.length; si++) {
    const playing = schedules[stretchIndices[si]]
    // Real roster
    for (const e of myRoster) {
      if (e.lineupSlotId === 16 || e.lineupSlotId === 17) continue
      const abbrev = PRO_TEAM_ABBREV[e.playerPoolEntry?.player?.proTeamId]
      if (!abbrev || !playing.has(abbrev)) {
        const pid = e.playerId
        if (!playerDropDays.has(pid))
          playerDropDays.set(pid, { name: e.playerPoolEntry?.player?.fullName, slots: [] })
        playerDropDays.get(pid).slots.push(si)
      }
    }
    // Overrides
    for (const o of MY_TEAM_OVERRIDES) {
      const abbrev = PRO_TEAM_ABBREV[o.proTeamId]
      if ((!abbrev || !playing.has(abbrev)) && !playerDropDays.has(o.playerId)) {
        playerDropDays.set(o.playerId, { name: o.name, slots: [] })
      }
      if (!abbrev || !playing.has(abbrev))
        playerDropDays.get(o.playerId)?.slots.push(si)
    }
  }

  // Pick best candidates (inactive on most stretch days)
  const dropCandidates = [...playerDropDays.entries()]
    .sort((a, b) => b[1].slots.length - a[1].slots.length)
    .slice(0, MAX_STRETCH_ADDS)

  // Build stretchReplacements: futureDateIndex -> [PlayerX entries for that day]
  const stretchReplacements = new Map()
  dropCandidates.forEach(([, { slots }], i) => {
    for (const si of slots) {
      const futureIdx = stretchIndices[si]
      if (!stretchReplacements.has(futureIdx)) stretchReplacements.set(futureIdx, [])
      stretchReplacements.get(futureIdx).push({
        name: `Player X${i + 1}`,
        playerId: null,
        avg: STRETCH_AVG,
        isStretchAdd: true,
      })
    }
  })

  const droppedPlayers = dropCandidates.map(([, { name }], i) => ({
    name,
    replacedBy: `Player X${i + 1}`,
  }))

  return {
    myTeamName: myTeam.name ?? myTeam.abbrev,
    oppTeamName: oppTeam?.name ?? oppTeam?.abbrev ?? 'Opponent',
    myCurrentScore,
    oppCurrentScore,
    myRoster,
    oppRoster,
    today,
    futureDates,
    schedules,
    stretchReplacements,
    droppedPlayers,
  }
}

app.get('/api/projection', async (req, res) => {
  try {
    const { myTeamName, oppTeamName, myCurrentScore, oppCurrentScore,
            myRoster, oppRoster, today, futureDates, schedules,
            stretchReplacements, droppedPlayers } = await loadMatchupData()

    const myScores = [Math.round(myCurrentScore)]
    const oppScores = [Math.round(oppCurrentScore)]
    const labels = [formatDate(today)]
    const days = [{ label: formatDate(today), myPlayers: [], oppPlayers: [] }]

    for (let i = 0; i < futureDates.length; i++) {
      const playing = schedules[i]
      const extra = stretchReplacements.get(i) ?? []
      const myPlayers = getActivePlayers(myRoster, playing, true, extra)
      const oppPlayers = getActivePlayers(oppRoster, playing, false)
      myScores.push(Math.round(myScores[myScores.length - 1] + myPlayers.filter(p => p.counts).reduce((s, p) => s + p.avg, 0)))
      oppScores.push(Math.round(oppScores[oppScores.length - 1] + oppPlayers.filter(p => p.counts).reduce((s, p) => s + p.avg, 0)))
      labels.push(formatDate(futureDates[i]))
      days.push({ label: formatDate(futureDates[i]), myPlayers, oppPlayers })
    }

    res.json({
      labels,
      myTeam: { name: myTeamName, scores: myScores },
      opponent: { name: oppTeamName, scores: oppScores },
      days,
      droppedPlayers,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ── Monte Carlo simulation ────────────────────────────────────────────────────

// Box-Muller normal sample
function randn() {
  let u, v
  do { u = Math.random() } while (u === 0)
  do { v = Math.random() } while (v === 0)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// Sample one player's fantasy points for a game
// CV (coeff of variation) ~0.38 is realistic for NBA fantasy
function samplePlayerScore(avg) {
  return Math.max(0, avg + randn() * avg * 0.38)
}

// Simulate one team's daily score given active players
// injured = Set of playerIds out for the rest of the matchup
function simDayScore(players, injured) {
  const scored = players
    .filter(p => p.counts && !injured.has(p.playerId))
    .filter(() => Math.random() > 0.07)   // 7% game-day DNP (rest/coach)
    .map(p => samplePlayerScore(p.avg))
    .sort((a, b) => b - a)
    .slice(0, 10)
  return scored.reduce((s, v) => s + v, 0)
}

// Apply season-ending injury risk each day (1.2% per active player per day)
function applyInjuries(players, injured) {
  for (const p of players) {
    if (!injured.has(p.playerId) && Math.random() < 0.012) {
      injured.add(p.playerId)
    }
  }
}

app.get('/api/simulate', async (req, res) => {
  try {
    const { myTeamName, oppTeamName, myCurrentScore, oppCurrentScore,
            myRoster, oppRoster, futureDates, schedules,
            stretchReplacements } = await loadMatchupData()

    const N = 1000
    const myFinals = [], oppFinals = [], diffs = []
    let myWins = 0

    for (let sim = 0; sim < N; sim++) {
      let myScore = myCurrentScore
      let oppScore = oppCurrentScore
      const myInjured = new Set()
      const oppInjured = new Set()

      for (let i = 0; i < futureDates.length; i++) {
        const playing = schedules[i]
        const extra = stretchReplacements.get(i) ?? []
        const myPlayers = getActivePlayers(myRoster, playing, true, extra)
        const oppPlayers = getActivePlayers(oppRoster, playing, false)

        applyInjuries(myPlayers, myInjured)
        applyInjuries(oppPlayers, oppInjured)

        myScore += simDayScore(myPlayers, myInjured)
        oppScore += simDayScore(oppPlayers, oppInjured)
      }

      myFinals.push(myScore)
      oppFinals.push(oppScore)
      diffs.push(myScore - oppScore)
      if (myScore > oppScore) myWins++
    }

    // Build histogram of score differences
    diffs.sort((a, b) => a - b)
    const minD = Math.floor(diffs[0] / 50) * 50
    const maxD = Math.ceil(diffs[diffs.length - 1] / 50) * 50
    const binSize = 50
    const bins = []
    for (let lo = minD; lo < maxD; lo += binSize) {
      const hi = lo + binSize
      bins.push({
        range: `${lo > 0 ? '+' : ''}${lo}`,
        count: diffs.filter(d => d >= lo && d < hi).length,
        win: lo >= 0,
      })
    }

    const pct = arr => v => arr.filter(x => x <= v).length / arr.length
    const sortedMy = [...myFinals].sort((a, b) => a - b)
    const sortedOpp = [...oppFinals].sort((a, b) => a - b)
    const p = n => Math.round(n)

    res.json({
      winProbability: myWins / N,
      myTeam: {
        name: myTeamName,
        p10: p(sortedMy[Math.floor(N * 0.10)]),
        p25: p(sortedMy[Math.floor(N * 0.25)]),
        p50: p(sortedMy[Math.floor(N * 0.50)]),
        p75: p(sortedMy[Math.floor(N * 0.75)]),
        p90: p(sortedMy[Math.floor(N * 0.90)]),
      },
      opponent: {
        name: oppTeamName,
        p10: p(sortedOpp[Math.floor(N * 0.10)]),
        p25: p(sortedOpp[Math.floor(N * 0.25)]),
        p50: p(sortedOpp[Math.floor(N * 0.50)]),
        p75: p(sortedOpp[Math.floor(N * 0.75)]),
        p90: p(sortedOpp[Math.floor(N * 0.90)]),
      },
      histogram: bins,
      n: N,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

app.get('/api/freeagents', async (req, res) => {
  const useRecent = req.query.period === 'l5'
  const avgFn = useRecent ? getPlayerRecentAvg : getPlayerAvg
  try {
    // Build remaining dates from today through Apr 5
    const endDate = new Date('2026-04-05T23:59:59')
    const startDate = new Date()
    startDate.setHours(0, 0, 0, 0)
    const remainingDates = []
    for (const cur = new Date(startDate); cur <= endDate; cur.setDate(cur.getDate() + 1))
      remainingDates.push(new Date(cur))

    // Fetch schedules + defensive ratings in parallel
    const [schedules, defRatings] = await Promise.all([
      Promise.all(remainingDates.map(d => getScheduleOnDate(d.toISOString().slice(0, 10).replace(/-/g, '')))),
      getTeamDefRatings(),
    ])

    // Build opponent lookup: abbrev -> [oppAbbrev, ...] across remaining dates
    const teamOpponents = {} // abbrev -> [oppAbbrev per game]
    for (const { matchups } of schedules) {
      for (const { home, away } of matchups) {
        ;(teamOpponents[home] = teamOpponents[home] ?? []).push(away)
        ;(teamOpponents[away] = teamOpponents[away] ?? []).push(home)
      }
    }

    // Compute league-average defensive rating for normalization
    const defValues = Object.values(defRatings).filter(Boolean)
    const leagueAvgDef = defValues.length
      ? defValues.reduce((s, v) => s + v, 0) / defValues.length
      : 113

    // Per-game adj: positive opp def (allows more pts) → bonus; capped at ±15%
    function scheduleAdjustedTotal(avg, abbrev) {
      const opponents = teamOpponents[abbrev] ?? []
      if (!opponents.length) return 0
      let total = 0
      for (const opp of opponents) {
        const oppDef = defRatings[opp] ?? leagueAvgDef
        const adj = Math.max(-0.15, Math.min(0.15, (oppDef - leagueAvgDef) / leagueAvgDef))
        total += avg * (1 + adj)
      }
      return total
    }

    // My roster drop candidates
    const rosterRes = await fetch(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&view=mTeam`,
      { headers }
    )
    if (!rosterRes.ok) throw new Error(`Roster fetch failed: ${rosterRes.status}`)
    const rosterData = await rosterRes.json()
    const myTeam = rosterData.teams?.find(t =>
      t.primaryOwner === SWID || (t.owners && t.owners.includes(SWID))
    )

    const myRosterPlayers = (myTeam?.roster?.entries ?? [])
      .filter(e => e.lineupSlotId !== 16 && e.lineupSlotId !== 17 && !MY_TEAM_REMOVALS.has(e.playerId))
      .map(e => {
        const p = e.playerPoolEntry?.player
        if (!p) return null
        const override = MY_TEAM_OVERRIDES.find(o => o.playerId === e.playerId)
        const avg = override ? (useRecent ? (override.avgRecent ?? override.avg) : override.avg) : avgFn(p)
        const abbrev = PRO_TEAM_ABBREV[override?.proTeamId ?? p.proTeamId] ?? null
        const injuryStatus = p.injured ? (p.injuryStatus ?? 'INJURED') : 'ACTIVE'
        const gamesLeft = (teamOpponents[abbrev] ?? []).length
        const adjustedTotal = scheduleAdjustedTotal(avg, abbrev)
        return {
          name: p.fullName,
          playerId: e.playerId,
          proTeam: abbrev ?? '?',
          position: getPlayerPositions(p),
          avg: Math.round(avg),
          gamesLeft,
          projectedTotal: Math.round(adjustedTotal),
          injuryStatus,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.projectedTotal - b.projectedTotal)  // lowest first = drop candidates

    // Fetch free agents via kona_player_info view
    const faFilter = JSON.stringify({
      players: {
        filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
        filterSlotIds: { value: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12] },
        limit: 200,
        sortPercOwned: { sortPriority: 1, sortAsc: false },
      }
    })

    const faRes = await fetch(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=kona_player_info`,
      { headers: { ...headers, 'x-fantasy-filter': faFilter } }
    )

    if (!faRes.ok) throw new Error(`Free agent fetch failed: ${faRes.status}`)
    const faData = await faRes.json()

    const players = (faData.players ?? [])
      .map(entry => {
        const poolEntry = entry.playerPoolEntry ?? entry
        const p = poolEntry?.player
        if (!p) return null

        const avg = avgFn(p)
        const injuryStatus = p.injured ? (p.injuryStatus ?? 'INJURED') : 'ACTIVE'
        if (injuryStatus === 'OUT' || injuryStatus === 'DOUBTFUL') return null

        const abbrev = PRO_TEAM_ABBREV[p.proTeamId] ?? null
        const gamesLeft = (teamOpponents[abbrev] ?? []).length
        const adjustedTotal = scheduleAdjustedTotal(avg, abbrev)

        return {
          name: p.fullName,
          playerId: entry.id ?? p.id,
          proTeam: abbrev ?? '?',
          position: getPlayerPositions(p),
          avg: Math.round(avg),
          gamesLeft,
          projectedTotal: Math.round(adjustedTotal),
          scheduleAdjusted: defValues.length > 0,
          injuryStatus,
          ownership: Math.round((poolEntry.percentOwned ?? 0) * 10) / 10,
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.projectedTotal - a.projectedTotal)

    res.json({
      dropCandidates: myRosterPlayers,
      players,
      remainingDates: remainingDates.map(d => d.toISOString().slice(0, 10)),
      scheduleAdjusted: defValues.length > 0,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

const POSITION_NAME = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' }

// Extract per-game box stats from sports.core API categories
function parseBoxStats(categories) {
  const WANT = ['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', '3PM', 'MIN', '+/-']
  const seen = new Set()
  const result = {}
  for (const cat of categories ?? []) {
    for (const s of cat.stats ?? []) {
      const abbr = s.abbreviation ?? s.name ?? ''
      if (WANT.includes(abbr) && !seen.has(abbr)) {
        seen.add(abbr)
        result[abbr] = s.displayValue ?? String(s.value ?? '')
      }
    }
  }
  // Calculate fantasy points from box stats
  const pts = parseFloat(result.PTS) || 0
  const reb = parseFloat(result.REB) || 0
  const ast = parseFloat(result.AST) || 0
  const stl = parseFloat(result.STL) || 0
  const blk = parseFloat(result.BLK) || 0
  const to  = parseFloat(result.TO)  || 0
  const tpm = parseFloat(result['3PM']) || 0
  const fpts = pts * 1 + reb * 1.2 + ast * 1.5 + stl * 3 + blk * 3 + to * -1 + tpm * 1
  result.FPTS = String(Math.round(fpts))
  return result
}

app.get('/api/player/:playerId', async (req, res) => {
  const { playerId } = req.params
  const pid = parseInt(playerId, 10)
  try {
    const faFilter = JSON.stringify({
      players: { filterIds: { value: [pid] }, filterSlotIds: { value: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17] } },
    })

    const [overviewRes, fantasyRes] = await Promise.all([
      fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/overview`),
      fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=kona_player_info`, { headers: { ...headers, 'x-fantasy-filter': faFilter } }),
    ])
    const [overview, fantasyData] = await Promise.all([overviewRes.json(), fantasyRes.json()])

    // Player identity + stats from league-filtered fantasy API
    const fantasyEntry = (fantasyData.players ?? [])[0]
    const fantasyInfo = fantasyEntry?.playerPoolEntry?.player ?? fantasyEntry?.player ?? {}
    const fStats = fantasyInfo.stats ?? []
    const seasonEntry = fStats.find(s => s.externalId === `${SEASON}` && s.statSplitTypeId === 0 && s.statSourceId === 1)
    const recentEntry = fStats.find(s => s.statSplitTypeId === 1 && s.statSourceId === 0)

    const identity = {
      name: fantasyInfo.fullName ?? '',
      position: POSITION_NAME[fantasyInfo.defaultPositionId] ?? '?',
      proTeam: PRO_TEAM_ABBREV[fantasyInfo.proTeamId] ?? '?',
      injuryStatus: fantasyInfo.injuryStatus ?? 'ACTIVE',
    }

    // Real NBA stats from ESPN overview
    const statsSection = overview.statistics ?? {}
    const statLabels = statsSection.labels ?? []
    const seasonStats = (statsSection.splits ?? [])[0]?.stats ?? []
    const ngSection = (overview.nextGame ?? {}).statistics ?? {}
    const l10Stats = ((Array.isArray(ngSection) ? ngSection[0]?.splits : ngSection.splits) ?? [])
      .find(s => s.type === 'lastTenGames')?.stats ?? []

    // Per-game box stats using gamelog event IDs + player's team ID
    const glEventMap = overview.gameLog?.events ?? {}
    const teamId = fantasyInfo.proTeamId  // ESPN fantasy proTeamId matches ESPN sports.core team ID

    // Fetch schedule, standings, and full season gamelog in parallel
    const [schedRes, standingsRes, gamelogRes] = await Promise.all([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule?season=2026`)
        .then(r => r.json()).catch(() => ({ events: [] })),
      fetch('https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2026&type=0&level=1')
        .then(r => r.json()).catch(() => ({ standings: { entries: [] } })),
      fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/gamelog?season=2026`)
        .then(r => r.json()).catch(() => ({ events: {} })),
    ])

    // Build abbrev → record map from standings (normalize to fantasy abbreviations)
    const recordMap = {}
    for (const entry of standingsRes?.standings?.entries ?? []) {
      const abbr = normAbbrev(entry.team?.abbreviation)
      if (!abbr) continue
      const stats = entry.stats ?? []
      const w = stats.find(s => s.name === 'wins')?.value ?? 0
      const l = stats.find(s => s.name === 'losses')?.value ?? 0
      recordMap[abbr] = `${Math.round(w)}-${Math.round(l)}`
    }

    const myAbbrev = PRO_TEAM_ABBREV[teamId] ?? ''
    const cutoff = new Date('2026-04-06T00:00:00Z')
    const now = new Date()

    // Build upcoming games list
    const upcomingRaw = (schedRes.events ?? [])
      .filter(e => { const d = new Date(e.date); return d > now && d < cutoff })
      .map(e => {
        const comp = (e.competitions ?? [{}])[0]
        const comps = comp.competitors ?? []
        const mine = comps.find(c => normAbbrev(c.team?.abbreviation) === myAbbrev) ?? comps.find(c => c.homeAway === 'home')
        const opp  = comps.find(c => normAbbrev(c.team?.abbreviation) !== myAbbrev) ?? comps.find(c => c.homeAway === 'away')
        const atVs = mine?.homeAway === 'home' ? 'vs' : '@'
        const oppAbbr = normAbbrev(opp?.team?.abbreviation ?? '?')
        const oppRecord = recordMap[oppAbbr] ?? ''
        const broadcast = (comp.broadcasts ?? [])[0]?.media?.shortName ?? (comp.broadcasts ?? [])[0]?.names?.[0] ?? null
        return { date: e.date, label: `${atVs} ${oppAbbr}`, oppAbbr, oppRecord, broadcast }
      })

    // Full season gamelog events — include per-game teamId to handle traded players
    const fullGlMap = gamelogRes.events ?? {}
    const allGlEntries = Object.entries(fullGlMap)
      .sort((a, b) => new Date(b[1].gameDate) - new Date(a[1].gameDate))
      .map(([eventId, ev]) => {
        const teamAbbr = ev.team?.abbreviation ? normAbbrev(ev.team.abbreviation) : null
        const gameTeamId = (teamAbbr ? ABBREV_TO_TEAM_ID[teamAbbr] : null) ?? teamId
        return [eventId, ev, gameTeamId]
      })

    // For each upcoming opponent, find all prior games this season vs that team
    const upcomingOppAbbrevs = [...new Set(upcomingRaw.map(g => g.oppAbbr))]
    const historyEntries = allGlEntries.filter(([, ev]) =>
      upcomingOppAbbrevs.includes(ev.opponent?.abbreviation)
    )

    // Fetch box stats for last-5 games AND all vs-upcoming-opponent games (deduplicated)
    const last5Entries = allGlEntries.slice(0, 5)
    // Build a map of eventId → gameTeamId for the needed events
    const neededTeamForEvent = {}
    for (const [eventId, , gameTeamId] of [...last5Entries, ...historyEntries])
      neededTeamForEvent[eventId] = gameTeamId
    const allNeededArr = Object.keys(neededTeamForEvent)

    const allStatsResults = await Promise.all(
      allNeededArr.map(eventId => {
        const gtid = neededTeamForEvent[eventId]
        return fetch(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${eventId}/competitions/${eventId}/competitors/${gtid}/roster/${playerId}/statistics/0`)
          .then(r => r.json()).catch(() => null)
      })
    )
    const statsById = {}
    allNeededArr.forEach((id, i) => { statsById[id] = allStatsResults[i] })

    const last5Games = last5Entries.map(([eventId, glEvent]) => {
      const box = statsById[eventId] ? parseBoxStats(statsById[eventId].splits?.categories ?? []) : {}
      return {
        date: glEvent.gameDate,
        atVs: glEvent.atVs ?? 'vs',
        opponent: glEvent.opponent?.abbreviation ?? '?',
        result: glEvent.gameResult ?? '?',
        ...box,
      }
    }).filter(g => g.PTS !== undefined)

    // Attach history to each upcoming game
    const upcomingGames = upcomingRaw.map(({ oppAbbr, ...game }) => {
      const history = historyEntries
        .filter(([, ev]) => ev.opponent?.abbreviation === oppAbbr)
        .map(([eventId, ev]) => {
          const box = statsById[eventId] ? parseBoxStats(statsById[eventId].splits?.categories ?? []) : {}
          return {
            date: ev.gameDate,
            atVs: ev.atVs ?? 'vs',
            result: ev.gameResult ?? '?',
            FPTS: box.FPTS ?? null,
          }
        })
        .filter(g => g.FPTS !== null)
      return { ...game, history }
    })

    // Ownership from overview.fantasy
    const ovFan = overview.fantasy ?? {}

    res.json({
      ...identity,
      statLabels,
      season: seasonStats,
      l10: l10Stats,
      fantasyAvg: seasonEntry?.appliedAverage ?? null,
      fantasyRecent: recentEntry?.appliedAverage ?? null,
      upcomingGames,
      last5Games,
      percentOwned: ovFan.percentOwned ?? null,
    })
  } catch (err) {
    console.error('Player API error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Shared helper: compute VS-avg expected totals for a flat list of player descriptors
async function computeVsAvg(playerList, cutoff, now) {
  // Step 1: fetch gamelog + schedule for each player in parallel
  const withSchedules = await Promise.all(playerList.map(async (pd) => {
    const myAbbrev = PRO_TEAM_ABBREV[pd.teamId] ?? ''
    const [gamelogData, schedData] = await Promise.all([
      fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${pd.playerId}/gamelog?season=2026`)
        .then(r => r.json()).catch(() => ({ events: {} })),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${pd.teamId}/schedule?season=2026`)
        .then(r => r.json()).catch(() => ({ events: [] })),
    ])
    const upcomingGames = (schedData.events ?? [])
      .filter(ev => { const d = new Date(ev.date); return d > now && d < cutoff })
      .map(ev => {
        const comp = (ev.competitions ?? [{}])[0]
        const comps = comp.competitors ?? []
        const mine = comps.find(c => normAbbrev(c.team?.abbreviation) === myAbbrev)
        const opp  = comps.find(c => normAbbrev(c.team?.abbreviation) !== myAbbrev)
        return { date: ev.date, atVs: mine?.homeAway === 'home' ? 'vs' : '@', oppAbbr: normAbbrev(opp?.team?.abbreviation ?? '?') }
      })
    // Include per-game teamId from gamelog (handles traded players who played for different teams)
    const allGames = Object.entries(gamelogData.events ?? {})
      .sort((a, b) => new Date(b[1].gameDate) - new Date(a[1].gameDate))
      .map(([eventId, ev]) => {
        const teamAbbr = ev.team?.abbreviation ? normAbbrev(ev.team.abbreviation) : null
        const gameTeamId = (teamAbbr ? ABBREV_TO_TEAM_ID[teamAbbr] : null) ?? pd.teamId
        return [eventId, ev, gameTeamId]
      })
    return { ...pd, upcomingGames, allGames }
  }))

  // Step 2: collect all box-stat fetches needed (historical games vs upcoming opponents)
  const statsToFetch = [], seen = new Set()
  for (const pd of withSchedules) {
    const upcomingOpps = new Set(pd.upcomingGames.map(g => g.oppAbbr))
    for (const [eventId, ev, gameTeamId] of pd.allGames) {
      if (!upcomingOpps.has(ev.opponent?.abbreviation)) continue
      const key = `${eventId}_${gameTeamId}_${pd.playerId}`
      if (!seen.has(key)) { seen.add(key); statsToFetch.push({ key, eventId, teamId: gameTeamId, playerId: pd.playerId }) }
    }
  }
  const statsResults = await Promise.all(
    statsToFetch.map(({ eventId, teamId, playerId }) =>
      fetch(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${eventId}/competitions/${eventId}/competitors/${teamId}/roster/${playerId}/statistics/0`)
        .then(r => r.json()).catch(() => null)
    )
  )
  const statsMap = {}
  statsToFetch.forEach(({ key }, i) => { statsMap[key] = statsResults[i] })

  // Step 3: build results
  return withSchedules.map(pd => {
    const { playerId, teamId, seasonAvg, upcomingGames, allGames } = pd
    const historyByOpp = {}
    for (const [eventId, ev, gameTeamId] of allGames) {
      const opp = ev.opponent?.abbreviation
      if (!opp) continue
      const key = `${eventId}_${gameTeamId}_${playerId}`
      const box = statsMap[key] ? parseBoxStats(statsMap[key].splits?.categories ?? []) : {}
      if (!box.FPTS) continue
      if (!historyByOpp[opp]) historyByOpp[opp] = []
      historyByOpp[opp].push({ date: ev.gameDate, result: ev.gameResult ?? '?', FPTS: parseInt(box.FPTS) })
    }
    const games = upcomingGames.map(g => {
      const history = historyByOpp[g.oppAbbr] ?? []
      const expectedFPTS = history.length > 0
        ? Math.round(history.reduce((s, h) => s + h.FPTS, 0) / history.length)
        : Math.round(seasonAvg)
      return { ...g, expectedFPTS, history, usedFallback: history.length === 0 }
    })
    return {
      name: pd.name,
      playerId,
      proTeam: PRO_TEAM_ABBREV[teamId] ?? '?',
      position: pd.position ?? '',
      injuryStatus: pd.injuryStatus ?? 'ACTIVE',
      ownership: pd.ownership ?? 0,
      seasonAvg: Math.round(seasonAvg * 10) / 10,
      games,
      expectedTotal: games.reduce((s, g) => s + g.expectedFPTS, 0),
    }
  })
}

app.get('/api/vs-avg', async (req, res) => {
  try {
    const cutoff = new Date('2026-04-06T00:00:00Z')
    const now = new Date()

    // Fetch my roster + free agents in parallel
    const faFilter = JSON.stringify({
      players: {
        filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
        filterSlotIds: { value: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17] },
        sortPercOwned: { sortAsc: false, sortPriority: 1 },
        limit: 200,
      },
    })
    const [leagueRes, faRes] = await Promise.all([
      fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&view=mTeam`, { headers })
        .then(r => r.json()),
      fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=kona_player_info`, { headers: { ...headers, 'x-fantasy-filter': faFilter } })
        .then(r => r.json()),
    ])

    const myEspnTeam = leagueRes.teams?.find(t => t.primaryOwner === SWID || (t.owners && t.owners.includes(SWID)))
    const myPlayerIds = new Set(
      (myEspnTeam?.roster?.entries ?? []).map(e => e.playerId)
    )

    // Build my roster descriptor list
    const myRosterList = (myEspnTeam?.roster?.entries ?? [])
      .filter(e => e.lineupSlotId !== 16 && e.lineupSlotId !== 17 && !MY_TEAM_REMOVALS.has(e.playerId))
      .map(e => {
        const player = e.playerPoolEntry?.player ?? {}
        const override = MY_TEAM_OVERRIDES.find(o => o.playerId === e.playerId)
        const teamId = override?.proTeamId ?? player.proTeamId
        if (!teamId) return null
        return {
          playerId: e.playerId,
          name: player.fullName ?? override?.name ?? '',
          teamId,
          seasonAvg: override?.avg ?? getPlayerAvg(player),
          position: getPlayerPositions(player),
          injuryStatus: player.injured ? (player.injuryStatus ?? 'INJURED') : 'ACTIVE',
          ownership: 100,
        }
      }).filter(Boolean)

    // Build FA descriptor list — FA entries use fa.player directly (not fa.playerPoolEntry.player)
    const faList = (faRes.players ?? [])
      .filter(fa => !myPlayerIds.has(fa.id))
      .filter(fa => (fa.player?.injuryStatus ?? 'ACTIVE') !== 'OUT')
      .map(fa => {
        const player = fa.player ?? {}
        const teamId = player.proTeamId
        if (!teamId) return null
        return {
          playerId: fa.id,
          name: player.fullName ?? '',
          teamId,
          seasonAvg: getPlayerAvg(player),
          position: getPlayerPositions(player),
          injuryStatus: player.injured ? (player.injuryStatus ?? 'INJURED') : 'ACTIVE',
          ownership: fa.percentOwned ?? 0,
        }
      }).filter(Boolean)
      .sort((a, b) => b.seasonAvg - a.seasonAvg)
      .slice(0, 20)

    // Compute VS avg for both sets in parallel
    const [myPlayers, faPlayers] = await Promise.all([
      computeVsAvg(myRosterList, cutoff, now),
      computeVsAvg(faList, cutoff, now),
    ])

    res.json({
      myPlayers: myPlayers.filter(p => p.games.length > 0).sort((a, b) => a.expectedTotal - b.expectedTotal),
      faPlayers: faPlayers.filter(p => p.games.length > 0).sort((a, b) => b.expectedTotal - a.expectedTotal),
    })
  } catch (err) {
    console.error('vs-avg error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Serve built frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/dist')))
  app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'client/dist/index.html')))
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
