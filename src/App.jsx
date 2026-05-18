import { useState, useEffect } from 'react';
import WalkCycle from './WalkCycle';

export default function App() {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const update = () => {
      const vw = window.innerWidth;
      // 482 = component width + borders; 32 = page padding; max 1.7x on wide screens
      setZoom(parseFloat(Math.min(1.7, Math.max(0.55, (vw - 32) / 482)).toFixed(3)));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-start',
      padding: '24px 0 40px',
    }}>
      <div style={{ zoom }}>
        <WalkCycle />
      </div>
    </div>
  );
}
