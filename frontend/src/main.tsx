import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthProvider } from '@/lib/auth-context'
import { RefreshProvider } from '@/lib/refresh-context'
import { AuthGate } from '@/components/auth/auth-gate'
import { LoadBoundary, LoadingPanel } from '@/components/load-boundary'
import { Toaster } from '@/components/ui/sonner'
import '@/app/globals.css'

const AppShell = lazy(() => import('@/components/app-shell').then((m) => ({ default: m.AppShell })))
const DashboardPage = lazy(() => import('@/app/page'))
const CaptchaPage = lazy(() => import('@/app/captcha-page'))
const NotificationsPage = lazy(() => import('@/app/notifications-page'))
const SettingsPage = lazy(() => import('@/app/settings-page'))
const GatewayPage = lazy(() => import('@/app/gateway-page'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <AuthProvider>
        <AuthGate>
          <RefreshProvider>
            <BrowserRouter>
              <LoadBoundary>
                <Suspense fallback={<LoadingPanel fullPage />}>
                <Routes>
                  <Route element={<AppShell />}>
                    <Route index element={<DashboardPage />} />
                    <Route path="captcha" element={<CaptchaPage />} />
                    <Route path="notifications" element={<NotificationsPage />} />
                    <Route path="gateway" element={<GatewayPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                  </Route>
                </Routes>
                </Suspense>
              </LoadBoundary>
            </BrowserRouter>
          </RefreshProvider>
          <Toaster richColors closeButton position="top-right" />
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)
