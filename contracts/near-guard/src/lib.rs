//! Spend Guard's on-chain guard for NEAR.
//!
//! The agent's NEAR sits in this contract's account. The agent holds only a function-call access
//! key on that account, limited to `pay`, and `pay` itself enforces the hard limits: the receiver
//! must be on the owner's allowlist, and the amount must fit under a per-payment cap and a daily
//! cap. A function-call key can't attach a deposit and can't sign a transfer, so a stolen agent key
//! can only make the payments the owner already allowed, up to the caps.
//!
//! The owner changes the allowlist and the caps, pauses the guard and withdraws its NEAR. Each of
//! those needs exactly 1 yoctoNEAR attached, which only a full-access key can do.
//!
//! The daily cap counts per UTC day (block time), not over a rolling 24 hours.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::IterableSet;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// Gas kept for `on_pay_done`, which only reads the transfer's result and fixes the day's total.
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Allowlist,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    allowlist: IterableSet<AccountId>,
    per_payment_cap: u128,
    daily_cap: u128,
    /// The UTC day `spent_today` belongs to: block time in days since the Unix epoch.
    day: u64,
    spent_today: u128,
    paused: bool,
}

/// Everything `get_policy` shows. Amounts are yoctoNEAR, as strings.
#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct PolicyView {
    pub owner: AccountId,
    pub allowlist: Vec<AccountId>,
    pub per_payment_cap: U128,
    pub daily_cap: U128,
    /// Spent on the current UTC day, so 0 once a new day has started even before the next payment.
    pub spent_today: U128,
    pub remaining_today: U128,
    pub paused: bool,
    /// What the guard could pay out now: its balance less what its storage locks.
    pub available: U128,
}

#[near]
impl Guard {
    /// Only the contract's own account may initialize it, so deploy and `new` go in one
    /// transaction signed by the account's full-access key.
    #[init]
    #[private]
    pub fn new(
        owner: AccountId,
        allowlist: Vec<AccountId>,
        per_payment_cap: U128,
        daily_cap: U128,
    ) -> Self {
        check_caps(per_payment_cap.0, daily_cap.0);
        let mut set = IterableSet::new(StorageKey::Allowlist);
        for receiver in allowlist {
            set.insert(receiver);
        }
        Self {
            owner,
            allowlist: set,
            per_payment_cap: per_payment_cap.0,
            daily_cap: daily_cap.0,
            day: today(),
            spent_today: 0,
            paused: false,
        }
    }

    /// Pays `amount` yoctoNEAR to `receiver`, if the policy allows it. Called by the agent with its
    /// function-call key on this account (the caller is then this account), or by the owner.
    /// Returns the result of `on_pay_done`: true once the transfer went through.
    pub fn pay(&mut self, receiver: AccountId, amount: U128) -> Promise {
        let caller = env::predecessor_account_id();
        require!(
            caller == env::current_account_id() || caller == self.owner,
            "only this account's agent key or the owner may pay"
        );
        require!(!self.paused, "the guard is paused");
        require!(
            self.allowlist.contains(&receiver),
            format!("{receiver} is not on the allowlist")
        );
        let amount = amount.0;
        require!(amount > 0, "the amount must be more than 0");
        require!(
            amount <= self.per_payment_cap,
            format!(
                "{amount} yoctoNEAR is above the per-payment cap of {}",
                self.per_payment_cap
            )
        );
        self.roll_day();
        let spent = self.spent_today.checked_add(amount).unwrap_or(u128::MAX);
        require!(
            spent <= self.daily_cap,
            format!(
                "{amount} yoctoNEAR would bring today's spending to {spent}, above the daily cap of {}",
                self.daily_cap
            )
        );
        require!(
            amount <= available(),
            format!("the guard holds only {} yoctoNEAR it can pay out", available())
        );
        // Counted before the transfer goes out; on_pay_done gives it back if the transfer fails.
        self.spent_today = spent;
        emit(
            "pay",
            json!({ "receiver": receiver, "amount": U128(amount), "spent_today": U128(spent), "day": self.day }),
        );
        Promise::new(receiver.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_pay_done(receiver, U128(amount), self.day),
            )
    }

    /// Reads how the transfer went. A failed transfer (to an account that does not exist, say)
    /// returns its NEAR to this account, so it no longer counts against the day's cap.
    #[private]
    pub fn on_pay_done(&mut self, receiver: AccountId, amount: U128, day: u64) -> bool {
        // A transfer's result is empty; anything but a failure means it went through.
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        if !ok {
            if self.day == day {
                self.spent_today = self.spent_today.saturating_sub(amount.0);
            }
            emit(
                "pay_failed",
                json!({ "receiver": receiver, "amount": amount, "spent_today": U128(self.spent_today) }),
            );
        }
        ok
    }

    // Owner only. Each needs exactly 1 yoctoNEAR attached: a function-call key can't attach a
    // deposit, so the agent's key can't call these even if the owner were this account.

    #[payable]
    pub fn set_caps(&mut self, per_payment_cap: U128, daily_cap: U128) {
        self.assert_owner();
        check_caps(per_payment_cap.0, daily_cap.0);
        self.per_payment_cap = per_payment_cap.0;
        self.daily_cap = daily_cap.0;
        emit(
            "set_caps",
            json!({ "per_payment_cap": per_payment_cap, "daily_cap": daily_cap }),
        );
    }

    #[payable]
    pub fn allow(&mut self, receiver: AccountId) {
        self.assert_owner();
        self.allowlist.insert(receiver.clone());
        emit("allow", json!({ "receiver": receiver }));
    }

    #[payable]
    pub fn disallow(&mut self, receiver: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&receiver);
        emit("disallow", json!({ "receiver": receiver }));
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("set_paused", json!({ "paused": paused }));
    }

    /// Sends `amount` yoctoNEAR back to the owner.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "the amount must be more than 0");
        require!(
            amount.0 <= available(),
            format!("the guard holds only {} yoctoNEAR it can pay out", available())
        );
        emit("withdraw", json!({ "to": self.owner, "amount": amount }));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn get_policy(&self) -> PolicyView {
        let spent = if self.day == today() { self.spent_today } else { 0 };
        PolicyView {
            owner: self.owner.clone(),
            allowlist: self.allowlist.iter().cloned().collect(),
            per_payment_cap: U128(self.per_payment_cap),
            daily_cap: U128(self.daily_cap),
            spent_today: U128(spent),
            remaining_today: U128(self.daily_cap.saturating_sub(spent)),
            paused: self.paused,
            available: U128(available()),
        }
    }

    pub fn is_allowed(&self, receiver: AccountId) -> bool {
        self.allowlist.contains(&receiver)
    }
}

impl Guard {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may change the guard"
        );
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR: only a full-access key can change the guard"
        );
    }

    fn roll_day(&mut self) {
        let now = today();
        if now != self.day {
            self.day = now;
            self.spent_today = 0;
        }
    }
}

fn check_caps(per_payment: u128, daily: u128) {
    require!(per_payment > 0, "the per-payment cap must be more than 0");
    require!(
        per_payment <= daily,
        "the per-payment cap can't be above the daily cap"
    );
}

fn today() -> u64 {
    env::block_timestamp() / DAY_NS
}

/// The account's balance less what its storage locks: what a transfer can take without failing.
fn available() -> u128 {
    let locked = env::storage_byte_cost()
        .as_yoctonear()
        .saturating_mul(env::storage_usage() as u128);
    env::account_balance().as_yoctonear().saturating_sub(locked)
}

/// A NEP-297 event, so indexers and the verify script can read what the guard did.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let line = json!({ "standard": "spend_guard", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

// Calls here go straight to the Rust methods, past the checks near-sdk adds to each exported
// function: that `pay` takes no deposit and that only the guard itself calls `on_pay_done`. Those
// two are shown on testnet instead (scripts/near-guard-stolen-key.js).
#[cfg(test)]
#[allow(unused_must_use)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    const NEAR: u128 = 10u128.pow(24);
    const MILLI: u128 = NEAR / 1000;

    fn guard_id() -> AccountId {
        "guard.owner.testnet".parse().unwrap()
    }
    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    fn weather() -> AccountId {
        "weather.sg-paywall.testnet".parse().unwrap()
    }
    fn maps() -> AccountId {
        "maps.sg-paywall.testnet".parse().unwrap()
    }
    fn rnaps() -> AccountId {
        "rnaps.sg-paywall.testnet".parse().unwrap()
    }

    /// A call to the guard from `caller` with `deposit` yoctoNEAR attached, on `day` (days since
    /// the epoch), with 5 NEAR in the guard.
    fn context(caller: AccountId, deposit: u128, day: u64) -> VMContextBuilder {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(guard_id())
            .signer_account_id(caller.clone())
            .predecessor_account_id(caller)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(5))
            .block_timestamp(day * DAY_NS + 3_600 * 1_000_000_000);
        ctx
    }

    const DAY: u64 = 20_402; // 10 Nov 2025 (UTC); any day works.

    /// As the agent's function-call key: the caller is the guard's own account, no deposit.
    fn as_agent(day: u64) {
        testing_env!(context(guard_id(), 0, day).build());
    }
    fn as_owner(deposit: u128) {
        testing_env!(context(owner(), deposit, DAY).build());
    }

    /// A guard for the demo: weather and maps allowed, 0.02 NEAR per payment, 0.05 NEAR a day.
    fn guard() -> Guard {
        testing_env!(context(guard_id(), 0, DAY).build());
        Guard::new(
            owner(),
            vec![weather(), maps()],
            U128(20 * MILLI),
            U128(50 * MILLI),
        )
    }

    fn transfers() -> Vec<(String, u128)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.to_string();
                r.actions.into_iter().filter_map(move |a| match a {
                    near_sdk::mock::MockAction::Transfer { deposit, .. } => {
                        Some((to.clone(), deposit.as_yoctonear()))
                    }
                    _ => None,
                })
            })
            .collect()
    }

    #[test]
    fn new_shows_its_policy() {
        let g = guard();
        let p = g.get_policy();
        assert_eq!(p.owner, owner());
        assert_eq!(p.allowlist.len(), 2);
        assert!(g.is_allowed(weather()) && g.is_allowed(maps()) && !g.is_allowed(rnaps()));
        assert_eq!(p.per_payment_cap, U128(20 * MILLI));
        assert_eq!(p.daily_cap, U128(50 * MILLI));
        assert_eq!(p.spent_today, U128(0));
        assert_eq!(p.remaining_today, U128(50 * MILLI));
        assert!(!p.paused);
        assert!(p.available.0 > 0 && p.available.0 <= 5 * NEAR);
    }

    #[test]
    #[should_panic(expected = "per-payment cap can't be above the daily cap")]
    fn new_refuses_a_per_payment_cap_above_the_daily_cap() {
        testing_env!(context(guard_id(), 0, DAY).build());
        Guard::new(owner(), vec![], U128(2 * MILLI), U128(MILLI));
    }

    #[test]
    fn the_agent_pays_an_allowed_receiver_within_the_caps() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(4 * MILLI));
        assert_eq!(transfers(), vec![(weather().to_string(), 4 * MILLI)]);
        assert_eq!(g.get_policy().spent_today, U128(4 * MILLI));
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("EVENT_JSON:{"));
        assert!(logs[0].contains(r#""event":"pay""#) && logs[0].contains("weather.sg-paywall.testnet"));
    }

    #[test]
    fn the_owner_may_pay_too() {
        let mut g = guard();
        as_owner(0);
        g.pay(maps(), U128(MILLI));
        assert_eq!(transfers(), vec![(maps().to_string(), MILLI)]);
    }

    #[test]
    #[should_panic(expected = "rnaps.sg-paywall.testnet is not on the allowlist")]
    fn a_look_alike_receiver_is_refused() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(rnaps(), U128(MILLI));
    }

    #[test]
    #[should_panic(expected = "above the per-payment cap")]
    fn a_payment_above_the_per_payment_cap_is_refused() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(20 * MILLI + 1));
    }

    #[test]
    #[should_panic(expected = "the amount must be more than 0")]
    fn a_zero_payment_is_refused() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(0));
    }

    #[test]
    #[should_panic(expected = "above the daily cap")]
    fn the_daily_cap_holds_across_payments() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(20 * MILLI));
        g.pay(maps(), U128(20 * MILLI));
        assert_eq!(g.get_policy().remaining_today, U128(10 * MILLI));
        g.pay(weather(), U128(10 * MILLI + 1));
    }

    #[test]
    fn the_daily_cap_is_reached_exactly() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(20 * MILLI));
        g.pay(maps(), U128(20 * MILLI));
        g.pay(weather(), U128(10 * MILLI));
        assert_eq!(g.get_policy().remaining_today, U128(0));
    }

    #[test]
    fn a_new_utc_day_starts_from_zero() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(20 * MILLI));
        g.pay(maps(), U128(20 * MILLI));
        as_agent(DAY + 1);
        assert_eq!(g.get_policy().spent_today, U128(0), "the view rolls over before any payment");
        g.pay(weather(), U128(20 * MILLI));
        assert_eq!(g.get_policy().spent_today, U128(20 * MILLI));
    }

    #[test]
    #[should_panic(expected = "only this account's agent key or the owner may pay")]
    fn a_stranger_cannot_pay() {
        let mut g = guard();
        testing_env!(context("someone.testnet".parse().unwrap(), 0, DAY).build());
        g.pay(weather(), U128(MILLI));
    }


    #[test]
    #[should_panic(expected = "the guard is paused")]
    fn a_paused_guard_pays_nothing() {
        let mut g = guard();
        as_owner(1);
        g.set_paused(true);
        as_agent(DAY);
        g.pay(weather(), U128(MILLI));
    }

    #[test]
    #[should_panic(expected = "it can pay out")]
    fn the_guard_cannot_pay_more_than_it_holds() {
        let mut g = guard();
        as_owner(1);
        g.set_caps(U128(10 * NEAR), U128(10 * NEAR));
        as_agent(DAY);
        g.pay(weather(), U128(6 * NEAR));
    }

    #[test]
    fn a_failed_transfer_gives_back_its_share_of_the_day() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(20 * MILLI));
        testing_env!(
            context(guard_id(), 0, DAY).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!g.on_pay_done(weather(), U128(20 * MILLI), DAY));
        assert_eq!(g.get_policy().spent_today, U128(0));
        assert!(get_logs()[0].contains(r#""event":"pay_failed""#));
    }

    #[test]
    fn a_transfer_that_went_through_stays_counted() {
        let mut g = guard();
        as_agent(DAY);
        g.pay(weather(), U128(20 * MILLI));
        testing_env!(
            context(guard_id(), 0, DAY).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(g.on_pay_done(weather(), U128(20 * MILLI), DAY));
        assert_eq!(g.get_policy().spent_today, U128(20 * MILLI));
    }


    #[test]
    fn the_owner_changes_the_allowlist_and_caps() {
        let mut g = guard();
        as_owner(1);
        g.allow(rnaps());
        assert!(g.is_allowed(rnaps()));
        g.disallow(rnaps());
        assert!(!g.is_allowed(rnaps()));
        g.set_caps(U128(MILLI), U128(2 * MILLI));
        let p = g.get_policy();
        assert_eq!((p.per_payment_cap, p.daily_cap), (U128(MILLI), U128(2 * MILLI)));
    }

    #[test]
    #[should_panic(expected = "only the owner may change the guard")]
    fn the_agent_key_cannot_change_the_allowlist() {
        let mut g = guard();
        as_agent(DAY);
        g.allow(rnaps());
    }

    #[test]
    #[should_panic(expected = "only the owner may change the guard")]
    fn the_agent_key_cannot_raise_the_caps() {
        let mut g = guard();
        testing_env!(context(guard_id(), 1, DAY).build());
        g.set_caps(U128(NEAR), U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "attach exactly 1 yoctoNEAR")]
    fn owner_changes_need_a_full_access_key() {
        let mut g = guard();
        as_owner(0);
        g.set_paused(true);
    }

    #[test]
    fn the_owner_withdraws_to_the_owner() {
        let mut g = guard();
        as_owner(1);
        g.withdraw(U128(NEAR));
        assert_eq!(transfers(), vec![(owner().to_string(), NEAR)]);
    }

    #[test]
    #[should_panic(expected = "only the owner may change the guard")]
    fn the_agent_key_cannot_withdraw() {
        let mut g = guard();
        as_agent(DAY);
        g.withdraw(U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "it can pay out")]
    fn the_owner_cannot_withdraw_more_than_the_guard_holds() {
        let mut g = guard();
        as_owner(1);
        g.withdraw(U128(6 * NEAR));
    }
}
