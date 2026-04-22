import styles from "@/styles/shell.module.css";

/**
 * Skeleton that matches ConsoleShell layout.
 * Used as the default loading.tsx for all console routes so
 * the user sees an instant shell frame while data fetches.
 */
export default function ConsoleLoading() {
  return (
    <div className={styles.root}>
      {/* Header */}
      <header className={styles.asHeader}>
        <div className={styles.headerInner}>
          <div className={styles.headerRow}>
            <div className={styles.headerLeft}>
              <span className={styles.appTitle} style={{ opacity: 0.5 }}>
                {"\u7075\u667aMindpal"}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Sidebar skeleton */}
      <aside className={styles.sideNav}>
        <nav className={styles.sideNavInner}>
          <div style={{ display: "grid", gap: 6, padding: "8px 0" }}>
            <div className="sl-skeleton" style={{ height: 12, width: 64 }} />
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={`a${i}`}
                className="sl-skeleton"
                style={{ height: 28, width: `${70 + ((i * 17) % 30)}%`, borderRadius: 6 }}
              />
            ))}
            <div style={{ height: 12 }} />
            <div className="sl-skeleton" style={{ height: 12, width: 80 }} />
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={`b${i}`}
                className="sl-skeleton"
                style={{ height: 28, width: `${60 + ((i * 13) % 35)}%`, borderRadius: 6 }}
              />
            ))}
          </div>
        </nav>
      </aside>

      {/* Content area – centered spinner */}
      <main className={styles.asContent}>
        <div
          className={styles.contentInner}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "40vh",
            gap: 12,
          }}
        >
          <div className="sl-spinner" />
        </div>
      </main>
    </div>
  );
}
