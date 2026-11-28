// Self-serve account deletion for https://the-antimatter.com/sundew/delete-account/
//
// Signs the person in (password, or a recovery link emailed by "Forgot
// password?") and calls the same delete_own_account() RPC as the app's
// Settings -> Account screen, so both delete exactly the same data.
//
// SUNDEW_CONFIG (url + publishable key) is written next to this file by
// legal/build-pages.js. The key is the same public one every app build ships
// with; RLS and the RPC's auth.uid() scoping are what protect the data.
(function () {
  'use strict';

  var root = document.getElementById('delete-tool');
  if (!root) return;

  var PAGE_URL = 'https://the-antimatter.com/sundew/delete-account/';
  var cfg = window.SUNDEW_CONFIG;
  if (!cfg || !window.supabase) {
    root.textContent = 'This form could not load. Please try again later, or delete your account from inside the app.';
    return;
  }

  // No persisted session: nothing lingers in the browser after the page closes.
  // detectSessionInUrl picks up the tokens a recovery link puts in the URL fragment.
  var client = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: true, flowType: 'implicit' },
  });

  // Mirrors lib/accountDeletion.ts in the app: photo files go first through the
  // Storage API (Supabase blocks deleting them from SQL), then the RPC deletes
  // the auth user and every table cascades. Keep the two in step.
  var BUCKET = 'plant-photos';
  var PAGE = 1000;

  function unwrap(res) {
    if (res.error) throw res.error;
    return res.data;
  }

  function listPhotos(folder) {
    var paths = [];
    function page(offset) {
      return client.storage.from(BUCKET).list(folder, { limit: PAGE, offset: offset }).then(unwrap).then(function (data) {
        var subfolders = [];
        (data || []).forEach(function (entry) {
          var full = folder + '/' + entry.name;
          if (entry.id === null) subfolders.push(full);
          else paths.push(full);
        });
        var more = data && data.length === PAGE ? page(offset + PAGE) : Promise.resolve();
        return more.then(function () {
          return subfolders.reduce(function (p, sub) {
            return p.then(function () {
              return listPhotos(sub).then(function (found) { paths.push.apply(paths, found); });
            });
          }, Promise.resolve());
        });
      });
    }
    return page(0).then(function () { return paths; });
  }

  function deleteAccount(userId) {
    return listPhotos(userId).then(function (paths) {
      var chain = Promise.resolve();
      for (var i = 0; i < paths.length; i += PAGE) {
        (function (batch) {
          chain = chain.then(function () { return client.storage.from(BUCKET).remove(batch).then(unwrap); });
        })(paths.slice(i, i + PAGE));
      }
      return chain;
    }).then(function () {
      return client.rpc('delete_own_account').then(unwrap);
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { node.addEventListener(ev, attrs.on[ev]); });
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function field(label, input) {
    return el('label', { class: 'field' }, [el('span', { text: label }), input]);
  }

  function message(text, kind) {
    return el('p', { class: 'msg' + (kind ? ' ' + kind : ''), role: kind === 'error' ? 'alert' : 'status', text: text });
  }

  function show(nodes) {
    root.replaceChildren.apply(root, nodes);
  }

  function busy(button, on, label) {
    button.disabled = on;
    button.textContent = on ? 'Working…' : label;
  }

  // Supabase puts link errors (expired, already used) in the fragment or query.
  function linkError() {
    var params = new URLSearchParams(location.hash.slice(1) + '&' + location.search.slice(1));
    var err = params.get('error_description') || params.get('error');
    return err ? err.replace(/\+/g, ' ') : null;
  }

  function signInView(notice) {
    var email = el('input', { type: 'email', autocomplete: 'email', required: '' });
    var password = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
    var submit = el('button', { type: 'submit', text: 'Sign in' });
    var status = el('div');
    if (notice) status.appendChild(notice);

    var form = el('form', {
      on: {
        submit: function (e) {
          e.preventDefault();
          status.replaceChildren();
          busy(submit, true, 'Sign in');
          client.auth.signInWithPassword({ email: email.value.trim(), password: password.value }).then(function (res) {
            busy(submit, false, 'Sign in');
            if (res.error) status.appendChild(message(res.error.message, 'error'));
            else confirmView(res.data.user);
          });
        },
      },
    }, [
      field('Email', email),
      field('Password', password),
      el('div', { class: 'actions' }, [
        submit,
        el('button', { type: 'button', class: 'link', text: 'Forgot password?', on: { click: function () { forgotView(email.value.trim()); } } }),
      ]),
      status,
    ]);
    show([form]);
  }

  function forgotView(prefill) {
    var email = el('input', { type: 'email', autocomplete: 'email', required: '' });
    email.value = prefill || '';
    var submit = el('button', { type: 'submit', text: 'Email me a link' });
    var status = el('div');

    var form = el('form', {
      on: {
        submit: function (e) {
          e.preventDefault();
          status.replaceChildren();
          busy(submit, true, 'Email me a link');
          client.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: PAGE_URL }).then(function (res) {
            busy(submit, false, 'Email me a link');
            if (res.error) {
              status.appendChild(message(res.error.message, 'error'));
            } else {
              // Same reply whether or not the address has an account.
              status.appendChild(message('If that address has a Sundew account, a link is on its way. Open it on this device to finish deleting. It can take a few minutes; check your spam folder too.'));
            }
          });
        },
      },
    }, [
      field('Email', email),
      el('div', { class: 'actions' }, [
        submit,
        el('button', { type: 'button', class: 'link', text: 'Back to sign in', on: { click: function () { signInView(); } } }),
      ]),
      status,
    ]);
    show([form]);
  }

  function confirmView(user) {
    var expected = (user.email || '').toLowerCase();
    var confirm = el('input', { type: 'email', autocomplete: 'off', spellcheck: 'false' });
    var submit = el('button', { type: 'submit', class: 'danger', text: 'Permanently delete', disabled: '' });
    var status = el('div');

    confirm.addEventListener('input', function () {
      submit.disabled = confirm.value.trim().toLowerCase() !== expected;
    });

    var form = el('form', {
      on: {
        submit: function (e) {
          e.preventDefault();
          if (confirm.value.trim().toLowerCase() !== expected) return;
          status.replaceChildren();
          busy(submit, true, 'Permanently delete');
          deleteAccount(user.id).then(function () {
            client.auth.signOut({ scope: 'local' }).finally(function () {
              show([
                message('Your Sundew account and all of its data have been deleted.', 'ok'),
                message('If you had a subscription, cancel it in your Apple ID or Google Play settings, or it will keep renewing.'),
              ]);
            });
          }, function (e) {
            busy(submit, false, 'Permanently delete');
            status.appendChild(message('Deletion failed: ' + (e && e.message ? e.message : e), 'error'));
          });
        },
      },
    }, [
      el('p', { class: 'msg' }, [
        document.createTextNode('Signed in as '),
        el('strong', { text: user.email || 'your account' }),
        document.createTextNode('. This permanently deletes the account, every plant record, and every photo. It cannot be undone.'),
      ]),
      field('Type your email to confirm', confirm),
      el('div', { class: 'actions' }, [
        submit,
        el('button', {
          type: 'button', class: 'link', text: 'Sign out',
          on: { click: function () { client.auth.signOut({ scope: 'local' }).finally(function () { signInView(); }); } },
        }),
      ]),
      status,
    ]);
    show([form]);
  }

  var err = linkError();
  client.auth.getSession().then(function (res) {
    var session = res.data && res.data.session;
    if (session) confirmView(session.user);
    else if (err) signInView(message('That link did not work (' + err + '). Links expire and can only be used once — request a new one with Forgot password?', 'error'));
    else signInView();
    if (err || session) history.replaceState(null, '', location.pathname);
  });
})();
