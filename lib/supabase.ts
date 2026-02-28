import { createClient } from '@supabase/supabase-js'
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://prmdcuzxowlabjdvcqkg.supabase.co').trim()
const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBybWRjdXp4b3dsYWJqZHZjcWtnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3MjkyODgsImV4cCI6MjA4MjMwNTI4OH0.YKPEnONVQrcXV3-Wh1yl64an41EhW-4DtxJH_rmFAow').trim()
export const supabase = createClient(url, key)
