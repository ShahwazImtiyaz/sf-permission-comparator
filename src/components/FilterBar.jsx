export default function FilterBar({ value, onChange, search, onSearch, searchPlaceholder, counts, singleUser }) {
  const diffDisabled  = counts != null && counts.diff === 0;
  const sharedDisabled = counts != null && counts.shared === 0;

  return (
    <div className="filter-bar-row">
      {search !== undefined && (
        <input
          className="filter-input"
          placeholder={searchPlaceholder || 'Search...'}
          value={search}
          onChange={e => onSearch(e.target.value)}
        />
      )}
      <div className="filter-toggle-group">
        <button className={`filter-btn ${value === 'all' ? 'active' : ''}`} onClick={() => onChange('all')}>
          All {counts ? <span key={counts.all} className="fc">{counts.all}</span> : null}
        </button>
        {!singleUser && (
          <button
            className={`filter-btn ${value === 'diff' ? 'active' : ''}${diffDisabled ? ' disabled' : ''}`}
            onClick={() => !diffDisabled && onChange('diff')}
            title={diffDisabled ? 'No differences found' : undefined}
          >
            Differences {counts ? <span key={counts.diff} className="fc diff">{counts.diff}</span> : null}
          </button>
        )}
        <button
          className={`filter-btn ${value === 'shared' ? 'active' : ''}${sharedDisabled ? ' disabled' : ''}`}
          onClick={() => !sharedDisabled && onChange('shared')}
          title={sharedDisabled ? 'No shared items found' : undefined}
        >
          {singleUser ? 'Accessible' : 'Shared'} {counts ? <span key={counts.shared} className="fc shared">{counts.shared}</span> : null}
        </button>
      </div>
    </div>
  );
}
