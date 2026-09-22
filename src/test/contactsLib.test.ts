import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  channelFromActivity, hashContacts, inviteUrl, savePendingInvite, takePendingInvite,
} from '@/lib/contacts';
import { inviteCodeFromPath, routeFromPath } from '@/lib/deepLinks';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('hashContacts', () => {
  it('manda solo huellas, una vez cada una, y sabe a qué contacto pertenecen', async () => {
    const { items, contactByRef } = await hashContacts([
      { id: 'a', name: 'Ana', phones: ['55 1234 5678', '+52 1 55 1234 5678'], emails: ['ANA@gmail.com'] },
      { id: 'b', name: 'Ana otra vez', phones: ['5512345678'], emails: [] },
      { id: 'c', name: 'Roto', phones: ['123'], emails: ['no-es-correo'] },
    ], 'es-MX');

    // Tres formas del mismo número + el correo = dos huellas distintas.
    expect(items.map((i) => i.h).sort()).toEqual([
      sha('email:ana@gmail.com'),
      sha('phone:+525512345678'),
    ].sort());
    expect(items.every((i) => /^[0-9a-f]{64}$/.test(i.h))).toBe(true);
    // Nada en claro en lo que viaja.
    expect(JSON.stringify(items)).not.toMatch(/ana|5512|gmail/i);
    // Las refs apuntan al contacto de origen (aunque la huella se repita).
    expect(contactByRef.get(items[0].ref)).toBe(0);
    expect([...contactByRef.values()]).toContain(1);
    expect([...contactByRef.values()]).not.toContain(2);
  });
});

describe('invitaciones', () => {
  beforeEach(() => localStorage.clear());

  it('el enlace solo lleva el código opaco', () => {
    expect(inviteUrl('AbCdEf1234')).toBe('https://alwaysconnected.vercel.app/i/AbCdEf1234');
  });

  it('reconoce el enlace por web y por esquema propio', () => {
    expect(inviteCodeFromPath('/i/AbCdEf1234')).toBe('AbCdEf1234');
    expect(inviteCodeFromPath('i/AbCdEf1234?x=1')).toBe('AbCdEf1234');
    expect(inviteCodeFromPath('/i/corto')).toBeNull();
    expect(inviteCodeFromPath('/i/../../etc')).toBeNull();
    expect(routeFromPath('/friends/find')).toBe('/friends/find');
  });

  it('la invitación pendiente se guarda validada y se consume una vez', () => {
    savePendingInvite('<script>');
    expect(takePendingInvite()).toBeNull();
    savePendingInvite('AbCdEf1234');
    expect(takePendingInvite()).toBe('AbCdEf1234');
    expect(takePendingInvite()).toBeNull();
  });

  it('el canal sale del activityType de iOS, sin más datos', () => {
    expect(channelFromActivity('com.apple.UIKit.activity.Message')).toBe('messages');
    expect(channelFromActivity('net.whatsapp.WhatsApp.ShareExtension')).toBe('whatsapp');
    expect(channelFromActivity('com.apple.UIKit.activity.Mail')).toBe('mail');
    expect(channelFromActivity('com.apple.UIKit.activity.CopyToPasteboard')).toBe('copy');
    expect(channelFromActivity('')).toBe('other');
  });
});
