import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

// 关闭浏览器滚动位置恢复：避免跨城市/跨路由回退时停在上一页的滚动位置，
// 也避免恢复过程把首屏之外的模块位移计入 CLS。
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
