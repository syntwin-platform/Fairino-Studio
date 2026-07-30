import { useMemo, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  MonitorCog,
  ShieldCheck,
  Sparkles
} from 'lucide-react'

import { loginToSynTwin } from '../../services/backendAuthClient'
import { useBackendAuthStore } from '../../store/backendAuthStore'
import { useRobotStore } from '../../store/robotStore'
import { CLOUD_STAGING_BACKEND_URL, LOCAL_BACKEND_URL } from '../../types/backendDevice'

const EMAIL_STORAGE_KEY = 'syntwin.backendProgram.email'

interface LoginScreenProps {
  initialBackendUrl: string
  onAuthenticated: (backendUrl: string) => void
}

type LoginEnvironment = 'cloud' | 'local'

const copy = {
  vi: {
    eyebrow: 'Nền tảng vận hành robot công nghiệp',
    headline: 'Điều khiển chính xác.',
    headlineAccent: 'Vận hành an toàn.',
    description:
      'Kết nối robot, giám sát nhà máy và triển khai chương trình trong một không gian làm việc thống nhất.',
    secure: 'Xác thực bảo mật qua SynTwin',
    realtime: 'Giám sát robot theo thời gian thực',
    protected: 'Phân quyền và bảo vệ dữ liệu doanh nghiệp',
    welcome: 'Chào mừng trở lại',
    welcomeSubtitle: 'Đăng nhập bằng tài khoản SynTwin của bạn.',
    environment: 'Môi trường kết nối',
    cloud: 'SynTwin Cloud',
    cloudDescription: 'Dành cho tài khoản và dữ liệu vận hành chính thức.',
    recommended: 'Khuyên dùng',
    local: 'Máy chủ nội bộ',
    localDescription: 'Dành cho kỹ thuật viên và môi trường trình diễn.',
    email: 'Email',
    emailPlaceholder: 'ten@doanhnghiep.com',
    password: 'Mật khẩu',
    passwordPlaceholder: 'Nhập mật khẩu',
    signIn: 'Đăng nhập vào FaiRobot Studio',
    signingIn: 'Đang xác thực...',
    accountHint: 'Tài khoản được đăng ký và quản lý trên hệ thống SynTwin.',
    invalidCredentials: 'Email hoặc mật khẩu không đúng.',
    connectionFailed: 'Không thể kết nối tới hệ thống. Hãy kiểm tra môi trường đã chọn.',
    language: 'Ngôn ngữ',
    securityNote: 'Mật khẩu không được lưu trên thiết bị này.'
  },
  en: {
    eyebrow: 'Industrial robot operations platform',
    headline: 'Precision control.',
    headlineAccent: 'Safer operations.',
    description:
      'Connect robots, monitor your factory, and deploy programs from one unified workspace.',
    secure: 'Secure SynTwin authentication',
    realtime: 'Real-time robot monitoring',
    protected: 'Enterprise access and data protection',
    welcome: 'Welcome back',
    welcomeSubtitle: 'Sign in with your SynTwin account.',
    environment: 'Connection environment',
    cloud: 'SynTwin Cloud',
    cloudDescription: 'For official accounts and operations data.',
    recommended: 'Recommended',
    local: 'Local server',
    localDescription: 'For technicians and demonstration environments.',
    email: 'Email',
    emailPlaceholder: 'name@company.com',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    signIn: 'Sign in to FaiRobot Studio',
    signingIn: 'Authenticating...',
    accountHint: 'Accounts are registered and managed in SynTwin.',
    invalidCredentials: 'Incorrect email or password.',
    connectionFailed: 'Unable to reach the system. Check the selected environment.',
    language: 'Language',
    securityNote: 'Your password is never stored on this device.'
  }
} as const

export default function LoginScreen({
  initialBackendUrl,
  onAuthenticated
}: LoginScreenProps): React.JSX.Element {
  const language = useRobotStore((state) => state.language)
  const setLanguage = useRobotStore((state) => state.setLanguage)
  const setSession = useBackendAuthStore((state) => state.setSession)
  const setConnectivity = useBackendAuthStore((state) => state.setConnectivity)
  const text = copy[language]
  const [environment, setEnvironment] = useState<LoginEnvironment>(
    initialBackendUrl === LOCAL_BACKEND_URL ? 'local' : 'cloud'
  )
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_STORAGE_KEY) || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  const backendUrl = environment === 'cloud' ? CLOUD_STAGING_BACKEND_URL : LOCAL_BACKEND_URL
  const environmentOptions = useMemo(
    () => [
      {
        id: 'cloud' as const,
        icon: Cloud,
        title: text.cloud,
        description: text.cloudDescription,
        badge: text.recommended
      },
      {
        id: 'local' as const,
        icon: MonitorCog,
        title: text.local,
        description: text.localDescription,
        badge: ''
      }
    ],
    [text]
  )

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!email.trim() || !password || isSubmitting) return

    setIsSubmitting(true)
    setError('')
    setConnectivity('checking')

    try {
      const response = await loginToSynTwin(backendUrl, email, password)

      localStorage.setItem(EMAIL_STORAGE_KEY, email.trim())
      setSession(response.accessToken, response.user)
      setPassword('')
      onAuthenticated(backendUrl)
    } catch (loginError) {
      setConnectivity('offline', loginError instanceof Error ? loginError.message : '')

      const message = loginError instanceof Error ? loginError.message : ''
      setError(
        /invalid email or password/i.test(message) ? text.invalidCredentials : text.connectionFailed
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="relative flex min-h-screen overflow-hidden bg-[#090b12] text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(37,99,235,0.20),transparent_34%),radial-gradient(circle_at_82%_76%,rgba(79,70,229,0.13),transparent_30%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:42px_42px]" />

      <section className="relative hidden min-h-screen w-[52%] flex-col justify-between border-r border-white/5 p-12 xl:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-black text-white shadow-[0_10px_40px_rgba(37,99,235,0.32)]">
            FAI
          </div>
          <div>
            <div className="text-base font-bold text-white">FaiRobot Studio</div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              Powered by SynTwin
            </div>
          </div>
        </div>

        <div className="max-w-2xl">
          <div className="mb-5 flex w-fit items-center gap-2 rounded-full border border-blue-400/20 bg-blue-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-300">
            <Sparkles size={13} />
            {text.eyebrow}
          </div>
          <h1 className="text-5xl font-semibold leading-[1.08] tracking-[-0.04em] text-white 2xl:text-6xl">
            {text.headline}
            <br />
            <span className="bg-gradient-to-r from-blue-400 to-indigo-300 bg-clip-text text-transparent">
              {text.headlineAccent}
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-slate-400">{text.description}</p>

          <div className="mt-10 grid max-w-xl gap-4">
            {[text.secure, text.realtime, text.protected].map((item) => (
              <div key={item} className="flex items-center gap-3 text-sm text-slate-300">
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
                  <CheckCircle2 size={14} />
                </span>
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-600">
          <ShieldCheck size={14} />
          {text.securityNote}
        </div>
      </section>

      <section className="relative flex min-h-screen flex-1 items-center justify-center px-5 py-10 sm:px-10">
        <div className="absolute right-6 top-6 flex items-center gap-2 rounded-lg border border-white/10 bg-[#11151f]/85 px-3 py-2 backdrop-blur">
          <Globe2 size={14} className="text-slate-400" />
          <span className="sr-only">{text.language}</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as 'vi' | 'en')}
            className="cursor-pointer bg-transparent text-xs font-semibold text-slate-300 outline-none"
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </div>

        <div className="w-full max-w-[520px]">
          <div className="mb-8 xl:hidden">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-black">
                FAI
              </div>
              <div>
                <div className="font-bold">FaiRobot Studio</div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                  Powered by SynTwin
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#11151f]/90 p-6 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8">
            <div className="mb-7">
              <h2 className="text-2xl font-semibold tracking-tight text-white">{text.welcome}</h2>
              <p className="mt-2 text-sm text-slate-400">{text.welcomeSubtitle}</p>
            </div>

            <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
              <fieldset>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                  {text.environment}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {environmentOptions.map((option) => {
                    const Icon = option.icon
                    const selected = environment === option.id

                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setEnvironment(option.id)}
                        className={`relative rounded-xl border p-3 text-left transition ${
                          selected
                            ? 'border-blue-500/70 bg-blue-500/10 shadow-[0_0_0_1px_rgba(59,130,246,0.12)]'
                            : 'border-white/10 bg-[#0b0e16] hover:border-white/20'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={`mt-0.5 rounded-lg p-2 ${
                              selected
                                ? 'bg-blue-500/15 text-blue-300'
                                : 'bg-white/5 text-slate-500'
                            }`}
                          >
                            <Icon size={16} />
                          </span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-slate-100">
                                {option.title}
                              </span>
                              {option.badge && (
                                <span className="rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[8px] font-bold uppercase text-emerald-300">
                                  {option.badge}
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block text-[10px] leading-4 text-slate-500">
                              {option.description}
                            </span>
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </fieldset>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-300">
                  {text.email}
                </span>
                <div className="flex items-center rounded-xl border border-white/10 bg-[#0b0e16] px-3 focus-within:border-blue-500/70">
                  <Globe2 size={15} className="shrink-0 text-slate-500" />
                  <input
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={text.emailPlaceholder}
                    className="h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-white outline-none placeholder:text-slate-600"
                  />
                </div>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-300">
                  {text.password}
                </span>
                <div className="flex items-center rounded-xl border border-white/10 bg-[#0b0e16] px-3 focus-within:border-blue-500/70">
                  <LockKeyhole size={15} className="shrink-0 text-slate-500" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={text.passwordPlaceholder}
                    className="h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-white outline-none placeholder:text-slate-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    className="rounded p-1 text-slate-500 transition hover:text-slate-300"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>

              {error && (
                <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || !email.trim() || !password}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-sm font-semibold text-white shadow-lg shadow-blue-950/40 transition hover:from-blue-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isSubmitting ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" />
                    {text.signingIn}
                  </>
                ) : (
                  <>
                    {text.signIn}
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 flex items-start gap-2 border-t border-white/5 pt-4 text-[11px] leading-5 text-slate-500">
              <ShieldCheck size={14} className="mt-0.5 shrink-0 text-slate-600" />
              {text.accountHint}
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
