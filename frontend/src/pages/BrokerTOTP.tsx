import { ArrowLeft, ExternalLink, Loader2, Shield } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { fetchCSRFToken } from '@/api/client'
import { BrokerAuthSignOut } from '@/components/auth/BrokerAuthSignOut'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/stores/authStore'
import { showToast } from '@/utils/toast'

interface FieldConfig {
  name: string
  label: string
  type: string
  placeholder: string
  pattern?: string
  maxLength?: number
  inputMode?: 'numeric' | 'text' | 'tel'
  hint?: string
  optional?: boolean
}

const SHOONYA_FIELDS: FieldConfig[] = [
  { name: 'userid', label: 'User ID', type: 'text', placeholder: 'Enter your User ID' },
  { name: 'password', label: 'Password', type: 'password', placeholder: 'Enter your Password' },
  {
    name: 'totp',
    label: 'TOTP',
    type: 'password',
    placeholder: 'Enter 6-digit TOTP',
    maxLength: 6,
    pattern: '[0-9]{6}',
    inputMode: 'numeric',
    hint: 'Get TOTP from your authenticator app',
  },
]

export default function BrokerTOTP() {
  const { broker } = useParams<{ broker: string }>()
  const navigate = useNavigate()
  const { login } = useAuthStore()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formData, setFormData] = useState<Record<string, string>>({})

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    if (broker && broker.toLowerCase() !== 'shoonya') {
      setError('Only Shoonya broker is supported.')
      setIsLoading(false)
      return
    }

    const missingFields = SHOONYA_FIELDS.filter((f) => !f.optional && !formData[f.name]?.trim())
    if (missingFields.length > 0) {
      setError('Please fill in all required fields.')
      setIsLoading(false)
      return
    }

    try {
      const csrfToken = await fetchCSRFToken()
      const form = new FormData()
      Object.entries(formData).forEach(([key, value]) => {
        form.append(key, value.trim())
      })
      form.append('csrf_token', csrfToken)

      const response = await fetch('/shoonya/callback', {
        method: 'POST',
        body: form,
        credentials: 'include',
      })

      const data = await response.json()

      if (data.status === 'success' || response.ok) {
        login(formData.userid || '', 'shoonya')
        showToast.success('Authentication successful')
        navigate('/dashboard')
      } else {
        setError(data.message || 'Authentication failed. Please try again.')
      }
    } catch {
      setError('Authentication failed. Please check your credentials and try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleInputChange = (name: string, value: string, field: FieldConfig) => {
    let filteredValue = value
    if (field.inputMode === 'numeric') {
      filteredValue = value.replace(/\D/g, '')
    }
    if (field.maxLength) {
      filteredValue = filteredValue.slice(0, field.maxLength)
    }
    setFormData((prev) => ({ ...prev, [name]: filteredValue }))
  }

  return (
    <div className="min-h-screen flex items-center justify-center py-8 px-4">
      <div className="container max-w-md">
        <Card className="shadow-xl">
          <CardHeader className="text-center relative">
            <Button
              variant="ghost"
              size="sm"
              className="absolute left-4 top-4"
              onClick={() => navigate('/broker')}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div className="flex justify-center mb-4 pt-6">
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Shield className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl">Shoonya Login</CardTitle>
            <CardDescription>Enter your credentials to authenticate with Shoonya</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {SHOONYA_FIELDS.map((field) => (
                <div key={field.name} className="space-y-2">
                  <Label htmlFor={field.name}>{field.label}</Label>
                  <Input
                    id={field.name}
                    type={field.type}
                    inputMode={field.inputMode}
                    placeholder={field.placeholder}
                    value={formData[field.name] || ''}
                    onChange={(e) => handleInputChange(field.name, e.target.value, field)}
                    required={!field.optional}
                    disabled={isLoading}
                    maxLength={field.maxLength}
                    pattern={field.pattern}
                    autoComplete={
                      field.type === 'password'
                        ? 'current-password'
                        : field.inputMode === 'numeric'
                          ? 'one-time-code'
                          : 'off'
                    }
                  />
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </div>
              ))}

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Authenticating...
                  </>
                ) : (
                  <>
                    <Shield className="mr-2 h-4 w-4" />
                    Authenticate
                  </>
                )}
              </Button>
            </form>

            <div className="mt-6 space-y-3 text-center text-sm text-muted-foreground">
              <p>Your credentials are securely transmitted and encrypted.</p>
              <div className="flex items-center justify-center gap-4">
                <Link
                  to="/broker"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  <ArrowLeft className="h-3 w-3" />
                  Back to Broker Selection
                </Link>
                <a
                  href="https://github.com/satyam296731-create/satyam-open-algo/blob/sp-trading-branding/docs/INDEX.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Documentation
                  <ExternalLink className="h-3 w-3" />
                </a>
                <BrokerAuthSignOut />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
