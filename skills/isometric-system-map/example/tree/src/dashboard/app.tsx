import { useEffect, useState } from 'react';

export function Dashboard() {
  const [records, setRecords] = useState<any[]>([]);
  useEffect(() => {
    fetch('/v1/records').then((r) => r.json()).then(setRecords);
  }, []);
  return <table>{records.map((r) => <tr key={r.id}><td>{r.id}</td></tr>)}</table>;
}
