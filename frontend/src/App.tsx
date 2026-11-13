import { useCallback, useEffect, useState } from "react";
import { fetchSites, type Site } from "./api/client";
import { LunarGlobe } from "./components/LunarGlobe";
import { SiteList } from "./components/SiteList";

function App() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setSites(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSites()
      .then((loaded) => {
        if (!cancelled) setSites(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <main>
      <h1>Lunar Planner</h1>
      <p className="banner">
        Phase 1 skeleton — sites are fictional and no visibility analysis is computed.
      </p>

      {error ? (
        <section className="error">
          <h2>Could not load sites</h2>
          <p>{error}</p>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </section>
      ) : sites === null ? (
        <p>Loading sites…</p>
      ) : (
        <SiteList sites={sites} />
      )}

      <LunarGlobe sites={sites ?? []} />
    </main>
  );
}

export default App;
