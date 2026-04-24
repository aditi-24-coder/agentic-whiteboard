import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createHost } from './host';
import './styles.css';

const host = createHost();
createRoot(document.getElementById('root')!).render(<App host={host} />);

window.addEventListener('error', (e) => host.post({ type: 'error', message: e.message }));
