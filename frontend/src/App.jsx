import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Compass,
  LayoutDashboard,
  Settings,
  User,
  Wallet,
  X
} from 'lucide-react';
import { api, authHeaders } from './lib/api';
import {
  CHART_INTERVALS,
  formatPercent,
  formatPrice,
  formatUsd,
  formatVolume,
  mergeWatchlistMarkets,
  resolveQuote
} from './lib/marketFormat.mjs';
import useMarketCatalogue from './hooks/useMarketCatalogue';
import useMarketStream from './hooks/useMarketStream';
import useWatchlist from './hooks/useWatchlist';

// Components
import Auth from './components/Auth';
import CandleChart from './components/CandleChart';
import ActivityDashboard from './components/ActivityDashboard';
import AICopilot from './components/AICopilot';
import NavRail from './components/NavRail';
import TopBar from './components/TopBar';
import TickerStrip from './components/TickerStrip';
import BottomNav from './components/BottomNav';
import MarketNavigator from './components/MarketNavigator';
import MarketsTable from './components/MarketsTable';
import TradeDock from './components/TradeDock';
import PortfolioPanel from './components/PortfolioPanel';
import SettingsPanel from './components/SettingsPanel';
import ProfilePanel from './components/ProfilePanel';

const NAV_ITEMS = [
  { id: 'terminal', label: 'Terminal', icon: LayoutDashboard },
  { id: 'markets', label: 'Markets', icon: Compass },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'copilot', label: 'Copilot', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'profile', label: 'Profile', icon: User }
];

const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter(item => (
  ['terminal', 'markets', 'portfolio', 'activity', 'settings'].includes(item.id)
));

const CHART_INDICATORS = ['SMA', 'EMA', 'NONE'];

function App() {
  // --- SESSION STATES ---
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // --- UI STATES ---
  const [currentView, setCurrentView] = useState('terminal');
  const [chartInterval, setChartInterval] = useState('5m');
  const [chartIndicator, setChartIndicator] = useState('SMA');
  const [marketsOpen, setMarketsOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);

  // --- MARKET STATES ---
  const [activeSymbol, setActiveSymbol] = useState('BTCUSDT');
  const [history, setHistory] = useState([]);
  const [historyStatus, setHistoryStatus] = useState('idle');

  // --- USER DATA STATES ---
  const [balance, setBalance] = useState(0);
  const [lockedBalance, setLockedBalance] = useState(0);
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);

  // --- 1. PERSISTENCE LOGIC ---
  // Tracks the session every in-flight response belongs to. Updated
  // synchronously on login/logout so a late response can never apply a
  // previous session's account data to the current one.
  const tokenRef = useRef(token);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const fetchUserProfile = useCallback(async (authToken) => {
    try {
      const res = await api.get('/api/auth/me', authHeaders(authToken));
      if (tokenRef.current !== authToken) return;
      setUser(res.data);
      setBalance(res.data.balance || 0);
      setLockedBalance(res.data.lockedBalance || 0);
      setPositions(res.data.portfolio || []);
      setTrades(res.data.trades ? [...res.data.trades].reverse() : []);
      setPendingOrders(res.data.pendingOrders || []);
    } catch (err) {
      // A failure for an earlier session must not log out the active one.
      if (tokenRef.current !== authToken) return;
      console.error("Session expired or invalid");
      handleLogout();
    } finally {
      if (tokenRef.current === authToken) setIsInitializing(false);
    }
  }, []);

  useEffect(() => {
    if (token) {
      fetchUserProfile(token);
    } else {
      setIsInitializing(false);
    }
  }, [token, fetchUserProfile]);

  // --- 2. MARKET DATA LOGIC ---
  const catalogue = useMarketCatalogue();
  const stream = useMarketStream({
    symbol: activeSymbol,
    interval: chartInterval,
    enabled: Boolean(token)
  });
  const {
    watchlist,
    toggle: toggleWatchlistSymbol,
    busy: watchlistBusy,
    error: watchlistError
  } = useWatchlist({ token, initial: user?.watchlist });

  const markets = catalogue.markets;

  const marketBySymbol = useMemo(
    () => new Map(markets.map(market => [market.symbol, market])),
    [markets]
  );
  const activeMarket = marketBySymbol.get(activeSymbol) || null;

  // The catalogue is the authority for tradeable symbols. A selection that is
  // no longer listed falls back to the first live market instead of querying a
  // pair the backend would reject.
  useEffect(() => {
    if (markets.length === 0) return;
    if (!markets.some(market => market.symbol === activeSymbol)) {
      setActiveSymbol(markets[0].symbol);
    }
  }, [markets, activeSymbol]);

  useEffect(() => {
    if (!token) return undefined;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let current = true;
    setHistory([]);
    setHistoryStatus('loading');

    api.get(
      `/api/history/${encodeURIComponent(activeSymbol)}?interval=${encodeURIComponent(chartInterval)}`,
      controller ? { signal: controller.signal } : undefined
    )
      .then(res => {
        if (!current) return;
        setHistory(Array.isArray(res.data) ? res.data : []);
        setHistoryStatus('ready');
      })
      .catch(err => {
        if (!current) return;
        if (err?.code === 'ERR_CANCELED') return;
        setHistory([]);
        setHistoryStatus('error');
      });

    return () => {
      current = false;
      if (controller) controller.abort();
    };
  }, [token, activeSymbol, chartInterval]);

  const activeQuote = useMemo(() => {
    const fromCatalogue = activeMarket ? resolveQuote(activeMarket, stream.quotes) : null;
    if (fromCatalogue) return fromCatalogue;
    const live = stream.quotes[activeSymbol];
    if (live && Number.isFinite(live.price) && live.price > 0) {
      return {
        price: live.price,
        changePercent: Number.isFinite(live.changePercent) ? live.changePercent : null,
        quoteVolume: Number.isFinite(live.quoteVolume) ? live.quoteVolume : null,
        live: true
      };
    }
    return null;
  }, [activeMarket, stream.quotes, activeSymbol]);

  const activeCandle = stream.candle
    && stream.candle.symbol === activeSymbol
    && stream.candle.interval === chartInterval
    ? stream.candle
    : null;

  const activeDepth = stream.depth && stream.depth.symbol === activeSymbol
    ? stream.depth
    : null;

  const stripMarkets = useMemo(() => {
    const starred = mergeWatchlistMarkets(markets, watchlist);
    return starred.length > 0 ? starred : markets.slice(0, 10);
  }, [markets, watchlist]);

  const activePosition = positions.find(position => position.symbol === activeSymbol) || null;
  const pnlUnknown = Boolean(activePosition)
    && (activePosition.costBasisStatus === 'UNKNOWN' || activePosition.avgPrice == null);
  const activePnl = activePosition && !pnlUnknown && activeQuote
    ? (activeQuote.price - activePosition.avgPrice) * activePosition.quantity
    : null;

  // --- 3. HELPER FUNCTIONS ---
  const refreshAccount = useCallback(() => {
    const current = tokenRef.current;
    if (!current) return undefined;
    return fetchUserProfile(current);
  }, [fetchUserProfile]);

  const handleTradeComplete = (newBalance, newPortfolio, newTrade, newPending) => {
    if (typeof newBalance === 'number') setBalance(newBalance);
    if (Array.isArray(newPortfolio)) setPositions(newPortfolio);
    if (newTrade) setTrades(prev => [newTrade, ...prev]);
    if (newPending) setPendingOrders(newPending);
    // Escrow is only authoritative on the server; reconcile after a fill.
    refreshAccount();
  };

  const handleLogout = () => {
    tokenRef.current = null;
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setBalance(0);
    setLockedBalance(0);
    setPositions([]);
    setTrades([]);
    setPendingOrders([]);
    setMarketsOpen(false);
    setTradeOpen(false);
    setCurrentView('terminal');
  };

  const handleLoginSuccess = (userData, userToken) => {
    tokenRef.current = userToken;
    setToken(userToken);
    setUser(userData);
    setBalance(userData.balance || 0);
    setLockedBalance(userData.lockedBalance || 0);
    setPositions(userData.portfolio || []);
    setTrades(userData.trades ? [...userData.trades].reverse() : []);
    setPendingOrders(userData.pendingOrders || []);
    setCurrentView('terminal');
  };

  // --- 4. RENDER LOGIC ---
  if (isInitializing) return (
    <div className="flex h-[100dvh] items-center justify-center bg-void font-mono text-xs uppercase tracking-[0.3em] text-ultraviolet">
      Initializing secure session
    </div>
  );

  if (!token) return <Auth onLogin={handleLoginSuccess} />;

  const selectView = view => {
    setCurrentView(view);
    setMarketsOpen(false);
    setTradeOpen(false);
  };

  const handleSelectMarket = symbol => {
    setActiveSymbol(symbol);
    setMarketsOpen(false);
    setCurrentView('terminal');
  };

  const changeNegative = Boolean(
    activeQuote && Number.isFinite(activeQuote.changePercent) && activeQuote.changePercent < 0
  );

  const navigator = extraProps => (
    <MarketNavigator
      markets={markets}
      quotes={stream.quotes}
      activeSymbol={activeSymbol}
      onSelect={handleSelectMarket}
      watchlist={watchlist}
      onToggleWatchlist={toggleWatchlistSymbol}
      watchlistBusy={watchlistBusy}
      catalogueMeta={{ stale: catalogue.stale, source: catalogue.source }}
      {...extraProps}
    />
  );

  const tradeDockProps = {
    token,
    activeSymbol,
    currentPrice: activeQuote ? activeQuote.price : undefined,
    market: activeMarket,
    quotes: stream.quotes,
    depth: activeDepth,
    onTradeComplete: handleTradeComplete
  };

  const catalogueAlert = catalogue.error ? (
    <p
      role="status"
      className="rounded-lg border border-amber/25 bg-amber/10 px-3 py-2 text-xs text-amber"
    >
      Live market catalogue is unavailable{catalogue.stale ? '; showing the last known symbol set' : ''}.
      Prices stay blank until a verified source reconnects.
    </p>
  ) : null;

  const chartOverlay = (() => {
    if (historyStatus === 'loading' && history.length === 0) {
      return `Syncing ${chartInterval.toUpperCase()} candles…`;
    }
    if (historyStatus === 'error' && history.length === 0) {
      return 'Historical candles are unavailable. Live quotes and trading remain active.';
    }
    if (historyStatus === 'ready' && history.length === 0 && !activeCandle) {
      return 'No candles returned for this market.';
    }
    return null;
  })();

  const renderTerminal = () => (
    <div className="space-y-3">
      {catalogueAlert}

      <section className="panel overflow-hidden" aria-label="Chart and market controls">
        <div className="flex flex-wrap items-start gap-3 border-b border-line-subtle px-3 py-3 md:px-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h1 className="font-display text-lg font-semibold tracking-tight">
                {activeMarket?.baseAsset || activeSymbol.replace(/USDT$/, '')}
                <span className="text-ink-muted"> / {activeMarket?.quoteAsset || 'USDT'}</span>
              </h1>
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{activeSymbol}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="metric text-2xl text-ink-primary">
                {activeQuote ? formatPrice(activeQuote.price) : '—'}
              </span>
              <span className={`metric text-xs ${changeNegative ? 'text-negative' : 'text-positive'}`}>
                {activeQuote ? formatPercent(activeQuote.changePercent) : '—'}
              </span>
              {activeQuote && !activeQuote.live && (
                <span className="rounded-full border border-amber/25 bg-amber/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber">
                  Snapshot
                </span>
              )}
            </div>
          </div>

          <div className="ml-auto flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-1" role="group" aria-label="Chart interval">
              {CHART_INTERVALS.map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChartInterval(value)}
                  aria-pressed={chartInterval === value}
                  className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${
                    chartInterval === value
                      ? 'bg-violet/20 text-ultraviolet'
                      : 'text-ink-muted hover:bg-panel-2 hover:text-ink-primary'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-end gap-1" role="group" aria-label="Chart indicator">
              {CHART_INDICATORS.map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChartIndicator(value)}
                  aria-pressed={chartIndicator === value}
                  className={`rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                    chartIndicator === value
                      ? 'bg-cyan/15 text-aqua'
                      : 'text-ink-muted hover:bg-panel-2 hover:text-ink-primary'
                  }`}
                >
                  {value === 'NONE' ? 'None' : value}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="relative h-[360px] px-1 pb-1 sm:h-[420px] lg:h-[480px]">
          <CandleChart
            key={`${activeSymbol}:${chartInterval}`}
            symbol={activeSymbol}
            interval={chartInterval}
            indicator={chartIndicator}
            initialData={history}
            candleData={activeCandle}
          />
          {chartOverlay && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
              <p className="rounded-lg border border-line-subtle bg-void/80 px-3 py-2 text-center font-mono text-[11px] text-ink-secondary backdrop-blur-sm">
                {chartOverlay}
              </p>
            </div>
          )}
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 min-[1440px]:grid-cols-4">
        <div className="panel p-3.5">
          <p className="eyebrow">Cash balance</p>
          <p className="metric mt-1 text-lg text-positive">{formatUsd(balance)}</p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-muted">Reserved {formatUsd(lockedBalance)}</p>
        </div>
        <div className="panel p-3.5">
          <p className="eyebrow">Unrealized PnL · {activeSymbol}</p>
          <p className={`metric mt-1 text-lg ${
            activePnl === null ? 'text-ink-muted' : activePnl >= 0 ? 'text-positive' : 'text-negative'
          }`}>
            {activePosition
              ? pnlUnknown
                ? 'N/A'
                : activePnl === null
                  ? '—'
                  : `${activePnl >= 0 ? '+' : ''}${formatUsd(activePnl)}`
              : '—'}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-muted">
            {activePosition
              ? pnlUnknown
                ? 'Cost basis unavailable'
                : `${activePosition.quantity} units`
              : 'No open position'}
          </p>
        </div>
        <div className="panel p-3.5">
          <p className="eyebrow">24h volume</p>
          <p className="metric mt-1 text-lg text-ink-primary">{formatVolume(activeQuote?.quoteVolume)}</p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-muted">Quote asset turnover</p>
        </div>
        <div className="panel p-3.5">
          <p className="eyebrow">Open limit orders</p>
          <p className="metric mt-1 text-lg text-amber">{pendingOrders.length}</p>
          <button
            type="button"
            onClick={() => selectView('activity')}
            className="mt-0.5 font-mono text-[10px] text-ink-muted underline-offset-2 transition-colors hover:text-ultraviolet hover:underline"
          >
            Open ledger
          </button>
        </div>
      </div>

      <section className="panel" aria-label="Recent executions">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Recent fills</p>
            <h2 className="font-display text-sm font-semibold">Latest executions</h2>
          </div>
          <button
            type="button"
            onClick={() => selectView('activity')}
            className="text-xs font-semibold text-ink-muted transition-colors hover:text-ultraviolet"
          >
            View all
          </button>
        </div>
        {trades.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-[11px] text-ink-muted">No executions yet.</p>
        ) : (
          <ul className="divide-y divide-line-subtle/50">
            {trades.slice(0, 5).map((trade, index) => (
              <li
                key={trade._id || trade.clientOrderId || `${trade.symbol}-${trade.timestamp}-${index}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className={`font-mono text-xs font-semibold ${
                    String(trade.type).includes('BUY') ? 'text-positive' : 'text-negative'
                  }`}>
                    {trade.type} {trade.symbol}
                  </p>
                  <p className="font-mono text-[10px] text-ink-muted">
                    {new Date(trade.timestamp).toLocaleString()}
                  </p>
                </div>
                <span className="metric text-xs text-ink-secondary">
                  {formatPrice(Number(trade.price))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const renderContent = () => {
    switch (currentView) {
      case 'markets':
        return (
          <div className="space-y-3">
            {catalogueAlert}
            <MarketsTable
              markets={markets}
              quotes={stream.quotes}
              watchlist={watchlist}
              activeSymbol={activeSymbol}
              onSelect={handleSelectMarket}
              onToggleWatchlist={toggleWatchlistSymbol}
              watchlistBusy={watchlistBusy}
            />
          </div>
        );
      case 'portfolio':
        return (
          <PortfolioPanel
            positions={positions}
            markets={markets}
            quotes={stream.quotes}
            balance={balance}
            lockedBalance={lockedBalance}
          />
        );
      case 'activity':
        return (
          <ActivityDashboard
            trades={trades}
            pendingOrders={pendingOrders}
            token={token}
            refreshData={refreshAccount}
          />
        );
      case 'copilot':
        return (
          <div className="mx-auto w-full max-w-2xl space-y-3">
            <header>
              <p className="eyebrow">AI execution desk</p>
              <h1 className="font-display text-lg font-semibold">Nexus Copilot</h1>
              <p className="mt-1 text-xs text-ink-muted">
                Every order is proposed first and executed only after you confirm it.
              </p>
            </header>
            <AICopilot
              token={token}
              watchlist={stream.quotes}
              onTradeComplete={handleTradeComplete}
            />
          </div>
        );
      case 'settings':
        return (
          <div className="mx-auto w-full max-w-2xl">
            <SettingsPanel
              catalogue={{
                source: catalogue.source,
                stale: catalogue.stale,
                updatedAt: catalogue.updatedAt,
                symbols: markets
              }}
              watchlist={watchlist}
              markets={markets}
              onToggleWatchlist={toggleWatchlistSymbol}
              watchlistBusy={watchlistBusy}
              watchlistError={watchlistError}
              streamStatus={stream.status}
              onLogout={handleLogout}
            />
          </div>
        );
      case 'profile':
        return (
          <div className="mx-auto w-full max-w-3xl">
            <ProfilePanel
              user={user}
              balance={balance}
              lockedBalance={lockedBalance}
              positions={positions}
              watchlist={watchlist}
              streamStatus={stream.status}
              catalogue={{
                source: catalogue.source,
                stale: catalogue.stale,
                updatedAt: catalogue.updatedAt,
                symbols: markets
              }}
              onLogout={handleLogout}
              onOpenSettings={() => selectView('settings')}
            />
          </div>
        );
      case 'terminal':
      default:
        return renderTerminal();
    }
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-void text-ink-primary">
      <NavRail
        items={NAV_ITEMS}
        current={currentView}
        onSelect={selectView}
        onLogout={handleLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          symbol={activeSymbol}
          quote={activeQuote}
          streamStatus={stream.status}
          stale={Boolean(catalogue.stale || catalogue.error)}
          onOpenMarkets={() => setMarketsOpen(true)}
          onOpenTrade={() => setTradeOpen(true)}
          onOpenProfile={() => selectView('profile')}
          onLogout={handleLogout}
        />

        <TickerStrip
          markets={stripMarkets}
          quotes={stream.quotes}
          activeSymbol={activeSymbol}
          onSelect={handleSelectMarket}
        />

        <div className="relative flex min-h-0 flex-1">
          {currentView === 'terminal' && (
            <aside
              aria-label="Market navigator"
              className="hidden w-[268px] shrink-0 border-r border-line-subtle/70 bg-graphite/40 xl:block"
            >
              {navigator()}
            </aside>
          )}

          <main className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-24 pt-3 md:px-4 md:pb-4">
            {renderContent()}
          </main>

          {currentView === 'terminal' && (
            <aside
              aria-label="Trading panel"
              className="scrollbar-thin hidden w-[352px] shrink-0 overflow-y-auto border-l border-line-subtle/70 bg-graphite/40 p-3 xl:block"
            >
              <TradeDock {...tradeDockProps} />
            </aside>
          )}
        </div>
      </div>

      <BottomNav
        items={PRIMARY_NAV_ITEMS}
        current={currentView}
        onSelect={selectView}
      />

      {marketsOpen && (
        <div className="fixed inset-0 z-40 xl:hidden" role="dialog" aria-modal="true" aria-label="Market navigator">
          <button
            type="button"
            onClick={() => setMarketsOpen(false)}
            aria-label="Close market navigator"
            className="absolute inset-0 h-full w-full bg-void/70 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 flex w-[86vw] max-w-[330px] flex-col border-r border-line-subtle bg-graphite shadow-lift md:left-[76px]">
            {navigator({ onClose: () => setMarketsOpen(false) })}
          </div>
        </div>
      )}

      {tradeOpen && (
        <div className="fixed inset-0 z-40 xl:hidden" role="dialog" aria-modal="true" aria-label="Trading panel">
          <button
            type="button"
            onClick={() => setTradeOpen(false)}
            aria-label="Close trading panel"
            className="absolute inset-0 h-full w-full bg-void/70 backdrop-blur-sm"
          />
          <div className="safe-bottom absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-y-auto rounded-t-2xl border-t border-line-subtle bg-graphite px-3 pt-3 shadow-lift md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[380px] md:rounded-none md:border-l md:border-t-0">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="eyebrow">Quick execution</p>
                <h2 className="font-display text-sm font-semibold">Trade {activeSymbol}</h2>
              </div>
              <button
                type="button"
                onClick={() => setTradeOpen(false)}
                aria-label="Close trading panel"
                className="rounded-md p-1.5 text-ink-muted hover:bg-panel-2 hover:text-ink-primary"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <TradeDock {...tradeDockProps} />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
