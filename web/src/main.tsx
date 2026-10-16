/** 前端入口：把 App 挂载到 #root。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('页面缺少 #root 容器，无法挂载 TsController 管理界面');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
