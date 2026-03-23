import React, { useState, useEffect } from 'react';

interface MetricData {
  cpu: number;
  memory: number;
  disk: number;
  network: number;
}

interface Alert {
  id: number;
  severity: string;
  message: string;
  metric_type: string;
  acknowledged: boolean;
  created_at: string;
}

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3200';
  const [metrics, setMetrics] = useState<MetricData>({ cpu: 0, memory: 0, disk: 0, network: 0 });
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, [apiUrl]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, [apiUrl]);

  async function fetchMetrics() {
    try {
      const res = await fetch(apiUrl + '/api/v1/metrics?limit=1');
      if (res.ok) {
        const data = await res.json();
        setMetrics(data[0] || { cpu: 0, memory: 0, disk: 0, network: 0 });
      }
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchAlerts() {
    try {
      const res = await fetch(apiUrl + '/api/v1/alerts?limit=5');
      if (res.ok) {
        const data = await res.json();
        setAlerts(data);
      }
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    }
  }

  if (loading) {
    return React.createElement('div', { className: 'min-h-screen bg-gray-900 text-white flex items-center justify-center' }, React.createElement('div', { className: 'text-2xl' }, 'Loading...'));
  }

  return React.createElement('div', { className: 'min-h-screen bg-gray-900 text-white p-8' },
    React.createElement('header', { className: 'mb-8' },
      React.createElement('h1', { className: 'text-3xl font-bold mb-2' }, 'Fenris'),
      React.createElement('p', { className: 'text-gray-400' }, 'Infrastructure Intelligence')
    ),
    React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-6' },
      React.createElement('div', { className: 'bg-gray-800 rounded-lg p-6' },
        React.createElement('h2', { className: 'text-xl font-semibold mb-4' }, 'Current Metrics'),
        React.createElement('div', { className: 'space-y-4' },
          React.createElement('div', null,
            React.createElement('span', { className: 'text-gray-400' }, 'CPU: '),
            React.createElement('span', { className: 'text-2xl font-bold text-green-400 ml-2' }, metrics.cpu.toFixed(1) + '%')
          ),
          React.createElement('div', null,
            React.createElement('span', { className: 'text-gray-400' }, 'Memory: '),
            React.createElement('span', { className: 'text-2xl font-bold text-green-400 ml-2' }, metrics.memory.toFixed(1) + '%')
          ),
          React.createElement('div', null,
            React.createElement('span', { className: 'text-gray-400' }, 'Disk: '),
            React.createElement('span', { className: 'text-2xl font-bold text-green-400 ml-2' }, metrics.disk.toFixed(1) + '%')
          ),
          React.createElement('div', null,
            React.createElement('span', { className: 'text-gray-400' }, 'Network: '),
            React.createElement('span', { className: 'text-2xl font-bold text-green-400 ml-2' }, metrics.network.toFixed(1) + ' MB/s')
          )
        )
      ),
      React.createElement('div', { className: 'bg-gray-800 rounded-lg p-6' },
        React.createElement('h2', { className: 'text-xl font-semibold mb-4' }, 'Recent Alerts'),
        alerts.length === 0 ? React.createElement('p', { className: 'text-gray-400' }, 'No alerts') : React.createElement('div', { className: 'space-y-3' },
          alerts.map(alert =>
            React.createElement('div', { key: alert.id, className: 'border-l-2 border-gray-700 pl-4 py-2' },
              React.createElement('div', { className: 'font-semibold ' + (alert.severity === 'critical' ? 'text-red-600' : alert.severity === 'warning' ? 'text-orange-600' : 'text-blue-600') }, alert.severity.toUpperCase() + ': ' + (alert.metric_type || 'GENERAL')),
              React.createElement('div', { className: 'text-sm text-gray-300' }, alert.message),
              React.createElement('div', { className: 'text-xs text-gray-500' }, new Date(alert.created_at).toLocaleString())
            )
          )
        )
      )
    )
  );
}

export default App;
