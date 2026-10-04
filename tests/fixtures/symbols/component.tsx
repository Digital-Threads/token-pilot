import { useEffect, useState } from 'react';

interface Props { items: string[]; cond: boolean; onSave?: () => void }

export function List({ items, cond }: Props) {
  return (
    <ul>
      <li>{items.length}</li>{items.map((x) => <b key={x}>{x}</b>)}
      <A b={1} />{cond && <B c={2} />}
    </ul>
  );
}

export function Page({ items, onSave }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const warn = (e: Event) => { if (open) { e.preventDefault(); } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open]);
  const handleSave = async () => {
    if (onSave) { await onSave(); }
  };
  return <div className="page">
    <header><h1 className="title">{items.length}</h1><p role="status">{open ? 'open' : 'closed'}</p></header>
    <Button onClick={() => setOpen(true)} icon={<Eye size={16} />}>Open</Button>
    {items.map((item) => (
      <Row key={item} label={item} onClick={() => { setOpen(false); }}>
        <span>{item}</span>
      </Row>
    ))}
    <footer><Button onClick={() => handleSave()} /></footer>
  </div>;
}

export const ratio = (s: string) => /[{]/.test(s) && s < 2;

export function Other() {
  return 1;
}

export class Third {
  run() {
    return <i>{this.constructor.name}</i>;
  }
}
