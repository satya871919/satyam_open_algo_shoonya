import { BookOpen, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BrokerAuthSignOut } from '@/components/auth/BrokerAuthSignOut'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuthStore } from '@/stores/authStore'

const SUPPORTED_BROKERS = [{ id: 'shoonya', name: 'Shoonya', authType: 'oauth' }] as const

interface BrokerConfig {
  broker_name: string
  broker_api_key: string
  redirect_url: string
}

export default function BrokerSelect() {
  const { user } = useAuthStore()
  const [selectedBroker, setSelectedBroker] = useState<string>('shoonya')
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brokerConfig, setBrokerConfig] = useState<BrokerConfig | null>(null)

  useEffect(() => {
    const fetchBrokerConfig = async () => {
      try {
        const response = await fetch('/auth/broker-config', {
          credentials: 'include',
        })
        const data = await response.json()

        if (data.status === 'success') {
          setBrokerConfig(data)
          setSelectedBroker(data.broker_name || 'shoonya')
        } else {
          setError(data.message || 'Failed to load broker configuration')
        }
      } catch {
        setError('Failed to load broker configuration')
      } finally {
        setIsLoading(false)
      }
    }

    fetchBrokerConfig()
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (selectedBroker !== 'shoonya') {
      setError('Only Shoonya broker is supported')
      return
    }

    if (!brokerConfig) {
      setError('Broker configuration not loaded')
      return
    }

    setIsSubmitting(true)
    setTimeout(() => {
      window.location.href = '/shoonya/callback'
    }, 100)
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center py-8 px-4">
      <div className="container max-w-6xl">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-8 lg:gap-16">
          {/* Right side broker form - Shown first on mobile */}
          <Card className="w-full max-w-md shadow-xl order-1 lg:order-2">
            <CardHeader className="text-center">
              <div className="flex justify-center mb-4">
                <BrandLogo variant="full" className="h-32 w-32 object-contain" />
              </div>
              <CardTitle className="text-2xl">Connect Your Trading Account</CardTitle>
              <CardDescription>
                Welcome, <span className="font-medium">{user?.username}</span>!
              </CardDescription>
            </CardHeader>
            <CardContent>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="broker-select" className="block text-center">
                    Login with your Broker
                  </Label>
                  <Select
                    value={selectedBroker}
                    onValueChange={setSelectedBroker}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id="broker-select" className="w-full">
                      <SelectValue placeholder="Select a Broker" />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_BROKERS.map((broker) => (
                        <SelectItem key={broker.id} value={broker.id}>
                          {broker.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button type="submit" className="w-full" disabled={!selectedBroker || isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Connect Shoonya Account
                    </>
                  )}
                </Button>
              </form>

              <div className="mt-6 text-center text-sm">
                <BrokerAuthSignOut />
              </div>
            </CardContent>
          </Card>

          {/* Left side content - Shown second on mobile */}
          <div className="flex-1 max-w-xl text-center lg:text-left order-2 lg:order-1">
            <h1 className="text-4xl lg:text-5xl font-bold mb-6">
              Connect Your <span className="text-primary">Shoonya</span> Account
            </h1>
            <p className="text-lg lg:text-xl mb-8 text-muted-foreground">
              Link your Shoonya trading account to start executing trades through SP Trading&apos;s
              algorithmic trading platform.
            </p>

            <Alert className="mb-6">
              <BookOpen className="h-4 w-4" />
              <AlertTitle>Need Help?</AlertTitle>
              <AlertDescription>Check our documentation for Shoonya setup guides.</AlertDescription>
            </Alert>

            <div className="flex justify-center lg:justify-start gap-4">
              <Button variant="outline" asChild>
                <a
                  href="https://github.com/satyam296731-create/satyam-open-algo/tree/sp-trading-branding/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="mr-2 h-4 w-4" />
                  Documentation
                </a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
