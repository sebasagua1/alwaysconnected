export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      badges: {
        Row: {
          badge_type: string
          earned_at: string
          id: string
          user_id: string
        }
        Insert: {
          badge_type: string
          earned_at?: string
          id?: string
          user_id: string
        }
        Update: {
          badge_type?: string
          earned_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      blocks: {
        Row: {
          blocked_id: string
          blocked_name: string | null
          blocker_id: string
          created_at: string
        }
        Insert: {
          blocked_id: string
          blocked_name?: string | null
          blocker_id: string
          created_at?: string
        }
        Update: {
          blocked_id?: string
          blocked_name?: string | null
          blocker_id?: string
          created_at?: string
        }
        Relationships: []
      }
      campuses: {
        Row: {
          created_at: string
          email_domain: string | null
          id: string
          lat: number | null
          lng: number | null
          name: string
        }
        Insert: {
          created_at?: string
          email_domain?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
        }
        Update: {
          created_at?: string
          email_domain?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
        }
        Relationships: []
      }
      contact_settings: {
        Row: {
          created_at: string
          discoverable: boolean
          last_synced_at: string | null
          notify_contacts_join: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          discoverable?: boolean
          last_synced_at?: string | null
          notify_contacts_join?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          discoverable?: boolean
          last_synced_at?: string | null
          notify_contacts_join?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      event_chat_state: {
        Row: {
          active_until: string | null
          created_at: string
          event_id: string
          last_pushed_at: string | null
          last_read_at: string
          muted: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          active_until?: string | null
          created_at?: string
          event_id: string
          last_pushed_at?: string | null
          last_read_at?: string
          muted?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          active_until?: string | null
          created_at?: string
          event_id?: string
          last_pushed_at?: string | null
          last_read_at?: string
          muted?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      event_moderation_log: {
        Row: {
          action: "delete_message" | "remove_participant" | "readmit_participant"
          actor_id: string | null
          created_at: string
          event_id: string
          id: number
          message_id: string | null
          target_user_id: string | null
        }
        Insert: {
          action: "delete_message" | "remove_participant" | "readmit_participant"
          actor_id?: string | null
          created_at?: string
          event_id: string
          id?: never
          message_id?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: "delete_message" | "remove_participant" | "readmit_participant"
          actor_id?: string | null
          created_at?: string
          event_id?: string
          id?: never
          message_id?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      event_removals: {
        Row: {
          created_at: string
          event_id: string
          reason: string | null
          removed_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          reason?: string | null
          removed_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          reason?: string | null
          removed_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      event_participants: {
        Row: {
          approval_seen: boolean
          approved_at: string | null
          checked_in: boolean
          event_id: string
          id: string
          joined_at: string
          rating: number | null
          status: string
          user_id: string
        }
        Insert: {
          approval_seen?: boolean
          approved_at?: string | null
          checked_in?: boolean
          event_id: string
          id?: string
          joined_at?: string
          rating?: number | null
          status?: string
          user_id: string
        }
        Update: {
          approval_seen?: boolean
          approved_at?: string | null
          checked_in?: boolean
          event_id?: string
          id?: string
          joined_at?: string
          rating?: number | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_participants_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          address: string | null
          category: string
          created_at: string
          creator_id: string
          current_spots: number
          description: string | null
          ends_at: string
          id: string
          is_active: boolean
          institution_id: string | null
          is_recurring: boolean
          lat: number | null
          lng: number | null
          max_spots: number
          privacy: string
          recurrence_rule: string | null
          repeated_from: string | null
          starts_at: string
          title: string
        }
        Insert: {
          address?: string | null
          category: string
          created_at?: string
          creator_id: string
          current_spots?: number
          description?: string | null
          ends_at: string
          id?: string
          is_active?: boolean
          institution_id?: string | null
          is_recurring?: boolean
          lat?: number | null
          lng?: number | null
          max_spots?: number
          privacy?: string
          recurrence_rule?: string | null
          repeated_from?: string | null
          starts_at: string
          title: string
        }
        Update: {
          address?: string | null
          category?: string
          created_at?: string
          creator_id?: string
          current_spots?: number
          description?: string | null
          ends_at?: string
          id?: string
          is_active?: boolean
          institution_id?: string | null
          is_recurring?: boolean
          lat?: number | null
          lng?: number | null
          max_spots?: number
          privacy?: string
          recurrence_rule?: string | null
          repeated_from?: string | null
          starts_at?: string
          title?: string
        }
        Relationships: []
      }
      friendships: {
        Row: {
          addressee_id: string
          created_at: string
          id: string
          requester_id: string
          status: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          id?: string
          requester_id: string
          status?: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          id?: string
          requester_id?: string
          status?: string
        }
        Relationships: []
      }
      group_members: {
        Row: {
          group_id: string
          id: string
          joined_at: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          group_id: string
          id?: string
          joined_at?: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          group_id?: string
          id?: string
          joined_at?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          photo_url: string | null
          source_event_id: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          photo_url?: string | null
          source_event_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          photo_url?: string | null
          source_event_id?: string | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          content: string
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          edited_at: string | null
          event_id: string | null
          expires_at: string | null
          group_id: string | null
          id: string
          is_announcement: boolean
          mentions: string[]
          sender_id: string
        }
        Insert: {
          content: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          edited_at?: string | null
          event_id?: string | null
          expires_at?: string | null
          group_id?: string | null
          id?: string
          is_announcement?: boolean
          mentions?: string[]
          sender_id: string
        }
        Update: {
          content?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          edited_at?: string | null
          event_id?: string | null
          expires_at?: string | null
          group_id?: string | null
          id?: string
          is_announcement?: boolean
          mentions?: string[]
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_codes: {
        Row: {
          code: string
          created_at: string
          inviter_id: string
        }
        Insert: {
          code: string
          created_at?: string
          inviter_id: string
        }
        Update: {
          code?: string
          created_at?: string
          inviter_id?: string
        }
        Relationships: []
      }
      point_events: {
        Row: {
          created_at: string
          event_id: string | null
          id: string
          points: number
          reason: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id?: string | null
          id?: string
          points: number
          reason: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string | null
          id?: string
          points?: number
          reason?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "point_events_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          origin: string | null
          availability: Json | null
          avatar_url: string | null
          campus_id: string | null
          institution_verified: boolean
          create_tip_seen: boolean
          terms_accepted_at: string | null
          student_id: string | null
          age_confirmed_at: string | null
          created_at: string
          email: string
          id: string
          interests: string[] | null
          languages: string[] | null
          major: string | null
          name: string | null
          onboarding_completed: boolean
          points: number
          reputation: number
          residence_type: string | null
          semester: number | null
          updated_at: string
        }
        Insert: {
          origin?: string | null
          availability?: Json | null
          avatar_url?: string | null
          campus_id?: string | null
          institution_verified?: boolean
          create_tip_seen?: boolean
          terms_accepted_at?: string | null
          student_id?: string | null
          age_confirmed_at?: string | null
          created_at?: string
          email: string
          id: string
          interests?: string[] | null
          languages?: string[] | null
          major?: string | null
          name?: string | null
          onboarding_completed?: boolean
          points?: number
          reputation?: number
          residence_type?: string | null
          semester?: number | null
          updated_at?: string
        }
        Update: {
          origin?: string | null
          availability?: Json | null
          avatar_url?: string | null
          campus_id?: string | null
          institution_verified?: boolean
          create_tip_seen?: boolean
          terms_accepted_at?: string | null
          student_id?: string | null
          age_confirmed_at?: string | null
          created_at?: string
          email?: string
          id?: string
          interests?: string[] | null
          languages?: string[] | null
          major?: string | null
          name?: string | null
          onboarding_completed?: boolean
          points?: number
          reputation?: number
          residence_type?: string | null
          semester?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_campus_id_fkey"
            columns: ["campus_id"]
            isOneToOne: false
            referencedRelation: "campuses"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          created_at: string
          details: string | null
          id: string
          reason: string
          reported_event_id: string | null
          reported_message_id: string | null
          reported_user_id: string | null
          reporter_id: string | null
          status: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          id?: string
          reason: string
          reported_event_id?: string | null
          reported_message_id?: string | null
          reported_user_id?: string | null
          reporter_id?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          details?: string | null
          id?: string
          reason?: string
          reported_event_id?: string | null
          reported_message_id?: string | null
          reported_user_id?: string | null
          reporter_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_reported_event_id_fkey"
            columns: ["reported_event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      public_profiles: {
        Row: {
          university_name: string | null
          university_short_name: string | null
          institution_type: string | null
          campus_name: string | null
          origin: string | null
          avatar_url: string | null
          campus_id: string | null
          institution_verified: boolean | null
          created_at: string | null
          id: string | null
          interests: string[] | null
          languages: string[] | null
          major: string | null
          name: string | null
          points: number | null
          reputation: number | null
          residence_type: string | null
          semester: number | null
        }
        Insert: {
          avatar_url?: string | null
          campus_id?: string | null
          institution_verified?: boolean | null
          created_at?: string | null
          id?: string | null
          interests?: string[] | null
          languages?: string[] | null
          major?: string | null
          name?: string | null
          points?: number | null
          reputation?: number | null
          residence_type?: string | null
          semester?: number | null
        }
        Update: {
          avatar_url?: string | null
          campus_id?: string | null
          institution_verified?: boolean | null
          created_at?: string | null
          id?: string | null
          interests?: string[] | null
          languages?: string[] | null
          major?: string | null
          name?: string | null
          points?: number | null
          reputation?: number | null
          residence_type?: string | null
          semester?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_campus_id_fkey"
            columns: ["campus_id"]
            isOneToOne: false
            referencedRelation: "campuses"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      add_group_member: {
        Args: { _group_id: string; _user_id: string }
        Returns: undefined
      }
      are_friends: {
        Args: { a: string; b: string }
        Returns: boolean
      }
      create_dm: {
        Args: { _other_user_id: string }
        Returns: string
      }
      check_in_to_event: {
        Args: { _event_id: string; _lat: number; _lng: number }
        Returns: Json
      }
      is_blocked: {
        Args: { a: string; b: string }
        Returns: boolean
      }
      rate_event: {
        Args: { p_event_id: string; p_rating: number; p_user_id: string }
        Returns: undefined
      }
      is_event_creator: {
        Args: { _event_id: string; _user_id: string }
        Returns: boolean
      }
      is_event_participant: {
        Args: { _event_id: string; _user_id: string }
        Returns: boolean
      }
      respond_to_join_request: {
        Args: { _approve: boolean; _event_id: string; _user_id: string }
        Returns: undefined
      }
      is_group_member: {
        Args: { _group_id: string; _user_id: string }
        Returns: boolean
      }
      mark_group_read: {
        Args: { _group_id: string }
        Returns: undefined
      }
      mark_approvals_seen: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      register_device_token: {
        Args: { _token: string; _platform?: string }
        Returns: undefined
      }
      unregister_device_token: {
        Args: { _token: string }
        Returns: undefined
      }
      notification_counts: {
        Args: Record<PropertyKey, never>
        Returns: {
          join_requests: number
          friend_requests: number
          unread_messages: number
          approvals: number
          group_invites: number
          event_chat_unread: number
        }[]
      }
      create_group_from_event: {
        Args: { _event_id: string; _name?: string }
        Returns: string
      }
      my_group_invites: {
        Args: Record<PropertyKey, never>
        Returns: {
          invite_id: string
          group_id: string
          group_name: string
          inviter_id: string
          inviter_name: string | null
          inviter_avatar: string | null
          event_title: string | null
          created_at: string
        }[]
      }
      respond_group_invite: {
        Args: { _invite_id: string; _accept: boolean }
        Returns: string | null
      }
      pending_requests_by_event: {
        Args: Record<PropertyKey, never>
        Returns: { event_id: string; pending: number }[]
      }
      event_attendees: {
        Args: { _event_id: string }
        Returns: {
          user_id: string
          name: string | null
          avatar_url: string | null
          is_creator: boolean
        }[]
      }
      friends_page: {
        Args: { _limit?: number; _offset?: number }
        Returns: {
          id: string
          name: string | null
          avatar_url: string | null
          major: string | null
          total: number
          dm_group_id: string | null
          last_message_at: string | null
          last_content: string | null
          last_sender_id: string | null
        }[]
      }
      can_access_event_chat: {
        Args: { _event_id: string }
        Returns: boolean
      }
      event_chat_summary: {
        Args: { _event_id: string }
        Returns: {
          can_access: boolean
          is_organizer: boolean
          removed: boolean
          muted: boolean
          last_read_at: string | null
          unread: number
          member_count: number
        }[]
      }
      event_chat_members: {
        Args: { _event_id: string }
        Returns: {
          user_id: string
          name: string | null
          avatar_url: string | null
          is_organizer: boolean
        }[]
      }
      mark_event_chat_read: {
        Args: { _event_id: string }
        Returns: undefined
      }
      set_event_chat_muted: {
        Args: { _event_id: string; _muted: boolean }
        Returns: boolean
      }
      set_event_chat_presence: {
        Args: { _event_id: string; _active: boolean }
        Returns: undefined
      }
      event_chat_unread: {
        Args: Record<PropertyKey, never>
        Returns: { event_id: string; unread: number }[]
      }
      moderate_event_message: {
        Args: { _message_id: string }
        Returns: undefined
      }
      remove_event_participant: {
        Args: { _event_id: string; _user_id: string; _reason?: string }
        Returns: undefined
      }
      readmit_event_participant: {
        Args: { _event_id: string; _user_id: string }
        Returns: undefined
      }
      event_removed_people: {
        Args: { _event_id: string }
        Returns: {
          user_id: string
          name: string | null
          avatar_url: string | null
          removed_at: string
        }[]
      }
      my_contact_settings: {
        Args: Record<PropertyKey, never>
        Returns: {
          discoverable: boolean
          notify_contacts_join: boolean
          last_synced_at: string | null
          identifiers: number
        }[]
      }
      set_contact_settings: {
        Args: { _discoverable: boolean; _notify_join: boolean }
        Returns: undefined
      }
      clear_contact_data: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      my_invite_code: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      log_invite_share: {
        Args: { _channel: string; _recipients: number }
        Returns: undefined
      }
      redeem_invite: {
        Args: { _code: string }
        Returns: {
          inviter_id: string
          name: string | null
          avatar_url: string | null
          relation: "none" | "outgoing" | "incoming" | "friends"
        }[]
      }
      my_invite_stats: {
        Args: Record<PropertyKey, never>
        Returns: { shared: number; accepted: number }[]
      }
      search_people: {
        Args: { _query: string; _limit?: number; _offset?: number }
        Returns: {
          id: string
          name: string
          avatar_url: string | null
          major: string | null
          relation: "none" | "outgoing" | "incoming" | "friends"
          friendship_id: string | null
          mutual_friends: number
        }[]
      }
      people_suggestions: {
        Args: { _limit?: number }
        Returns: {
          id: string
          name: string
          avatar_url: string | null
          major: string | null
          mutual_friends: number
          shared_groups: number
          in_contacts: boolean
        }[]
      }
      search_normalize: {
        Args: { _t: string }
        Returns: string
      }
      chat_summaries: {
        Args: Record<PropertyKey, never>
        Returns: {
          group_id: string
          group_name: string
          last_message_at: string | null
          last_content: string | null
          last_sender_id: string | null
        }[]
      }
      friend_requests_incoming: {
        Args: { _limit?: number }
        Returns: {
          friendship_id: string
          id: string
          name: string | null
          avatar_url: string | null
          major: string | null
        }[]
      }
      search_institutions: {
        Args: {
          _query?: string | null
          _country_code?: string | null
          _type?: string | null
          _limit?: number
          _offset?: number
          _lat?: number | null
          _lng?: number | null
        }
        Returns: {
          campus_id: string
          campus_name: string | null
          campus_city: string | null
          university_id: string
          university_name: string
          short_name: string | null
          institution_type: string
          country_code: string
          state_region: string | null
          city: string | null
          campus_count: number
          verification_available: boolean
          email_verified: boolean
        }[]
      }
      my_institution_verification: {
        Args: Record<PropertyKey, never>
        Returns: {
          status: "unverified" | "pending_email" | "verified" | "expired" | "revoked" | "manual_review"
          status_reason: string | null
          university_id: string | null
          university_name: string | null
          institution_type: string | null
          campus_id: string | null
          campus_name: string | null
          email_masked: string | null
          verification_method: string | null
          verified_at: string | null
          pending_email_masked: string | null
          pending_expires_at: string | null
          pending_resend_after: string | null
          pending_attempts_left: number | null
          verification_available: boolean
        }[]
      }
      confirm_institution_verification: {
        Args: { _code: string }
        Returns: { status: string; attempts_left: number }[]
      }
      request_institution: {
        Args: {
          _kind: "add_institution" | "manual_verification"
          _institution_name?: string | null
          _country_code?: string | null
          _city?: string | null
          _website_url?: string | null
          _notes?: string | null
          _university_id?: string | null
          _campus_id?: string | null
        }
        Returns: string
      }
      campus_options: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          slug: string
          name: string
          campus_name: string | null
          city: string | null
          short_name: string | null
          university_slug: string
          university_name: string
          university_short_name: string
          country_code: string
          email_verified: boolean
        }[]
      }
      my_email_university: {
        Args: Record<PropertyKey, never>
        Returns: string | null
      }
      email_domain: {
        Args: { _email: string }
        Returns: string | null
      }
      unread_by_group: {
        Args: Record<PropertyKey, never>
        Returns: { group_id: string; group_name: string; unread: number }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
