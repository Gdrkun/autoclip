import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { Layout } from 'antd'
import { t } from './i18n'
const HomePage = lazy(() => import('./pages/HomePage'))
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'))
const PublishClipPage = lazy(() => import('./pages/PublishClipPage'))
const PublishListPage = lazy(() => import('./pages/PublishListPage'))
const PublishWeekPage = lazy(() => import('./pages/PublishWeekPage'))
const ImportReview = lazy(() => import('./features/studio/ImportReview'))
const StudioEditor = lazy(() => import('./features/studio/StudioEditor'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
import Header from './components/Header'
import { UpdateProvider } from './desktop/UpdatePrompt'
import { trackPageview } from './analytics/posthog'
import { startWorkflowObserver } from './analytics/observer'

const { Content } = Layout

// HashRouter 下手动上报 pageview（init 时已关闭自动 pageview）
function usePageviewTracking() {
  const location = useLocation()
  useEffect(() => {
    trackPageview(location.pathname + location.search)
  }, [location.pathname, location.search])
}

function App() {
  console.log('🎬 App组件已加载');
  usePageviewTracking()
  useEffect(() => startWorkflowObserver(), [])

  return (
    <UpdateProvider>
      <Layout>
        <Header />
        <Content>
          <Suspense fallback={<div className="ac-page" role="status">{t('加载中…')}</div>}><Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/import/:id" element={<ImportReview />} />
            <Route path="/project/:id/studio/:draftId" element={<StudioEditor />} />
            <Route path="/project/:id/publish/week" element={<PublishWeekPage />} />
            <Route path="/project/:id/publish/:clipId" element={<PublishClipPage />} />
            <Route path="/project/:id/publish" element={<PublishListPage />} />
            <Route path="/project/:id" element={<ProjectDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes></Suspense>
        </Content>
      </Layout>
    </UpdateProvider>
  )
}

export default App
