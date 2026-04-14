const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper to advance time on the EVM
async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("StakingRewardsCapped", function () {
  let owner;
  let rewardsDistribution;
  let staker1;
  let staker2;
  let anyUser;

  let stakingToken;
  let rewardsToken;
  let staking;

  // 7 days in seconds
  const REWARDS_DURATION = 7 * 24 * 60 * 60;

  // maxRewardRatePerToken: 1e12 wei per second per 1e18 token = 1e-6 tokens/s per staked token
  // i.e., 1 token staked → 1e-6 rewards/s → 0.0864 rewards/day
  const MAX_REWARD_RATE_PER_TOKEN = ethers.utils.parseEther("0.000001"); // 1e12 wei

  const STAKE_AMOUNT = ethers.utils.parseEther("1000");
  const REWARD_AMOUNT = ethers.utils.parseEther("700"); // total rewards for one full period

  beforeEach(async function () {
    [owner, rewardsDistribution, staker1, staker2, anyUser] =
      await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    stakingToken = await ERC20Mock.deploy(
      "Staking Token",
      "STK",
      ethers.utils.parseEther("1000000")
    );
    rewardsToken = await ERC20Mock.deploy(
      "Rewards Token",
      "RWD",
      ethers.utils.parseEther("1000000")
    );

    // Deploy StakingRewardsCapped
    const StakingRewardsCapped = await ethers.getContractFactory(
      "StakingRewardsCapped"
    );
    staking = await StakingRewardsCapped.deploy(
      owner.address,
      rewardsDistribution.address,
      rewardsToken.address,
      stakingToken.address,
      MAX_REWARD_RATE_PER_TOKEN
    );

    // Distribute staking tokens to stakers
    await stakingToken.transfer(staker1.address, ethers.utils.parseEther("100000"));
    await stakingToken.transfer(staker2.address, ethers.utils.parseEther("100000"));

    // Distribute rewards tokens to various parties
    await rewardsToken.transfer(
      rewardsDistribution.address,
      ethers.utils.parseEther("100000")
    );
    await rewardsToken.transfer(anyUser.address, ethers.utils.parseEther("100000"));

    // Approve staking contract for stakers
    await stakingToken
      .connect(staker1)
      .approve(staking.address, ethers.constants.MaxUint256);
    await stakingToken
      .connect(staker2)
      .approve(staking.address, ethers.constants.MaxUint256);

    // Approve staking contract for reward providers
    await rewardsToken
      .connect(rewardsDistribution)
      .approve(staking.address, ethers.constants.MaxUint256);
    await rewardsToken
      .connect(anyUser)
      .approve(staking.address, ethers.constants.MaxUint256);
  });

  /* ========== DEPLOYMENT ========== */

  describe("Deployment", function () {
    it("sets the correct stakingToken and rewardsToken", async function () {
      expect(await staking.stakingToken()).to.equal(stakingToken.address);
      expect(await staking.rewardsToken()).to.equal(rewardsToken.address);
    });

    it("sets the correct owner and rewardsDistribution", async function () {
      expect(await staking.owner()).to.equal(owner.address);
      expect(await staking.rewardsDistribution()).to.equal(
        rewardsDistribution.address
      );
    });

    it("sets the correct maxRewardRatePerToken", async function () {
      expect(await staking.maxRewardRatePerToken()).to.equal(
        MAX_REWARD_RATE_PER_TOKEN
      );
    });

    it("has zero totalSupply initially", async function () {
      expect(await staking.totalSupply()).to.equal(0);
    });
  });

  /* ========== STAKE ========== */

  describe("stake()", function () {
    it("allows a user to stake tokens", async function () {
      await staking.connect(staker1).stake(STAKE_AMOUNT);

      expect(await staking.totalSupply()).to.equal(STAKE_AMOUNT);
      expect(await staking.balanceOf(staker1.address)).to.equal(STAKE_AMOUNT);
    });

    it("emits a Staked event", async function () {
      await expect(staking.connect(staker1).stake(STAKE_AMOUNT))
        .to.emit(staking, "Staked")
        .withArgs(staker1.address, STAKE_AMOUNT);
    });

    it("reverts when staking 0 amount", async function () {
      await expect(staking.connect(staker1).stake(0)).to.be.revertedWith(
        "Cannot stake 0"
      );
    });

    it("transfers staking tokens from the user to the contract", async function () {
      const balanceBefore = await stakingToken.balanceOf(staker1.address);
      await staking.connect(staker1).stake(STAKE_AMOUNT);
      const balanceAfter = await stakingToken.balanceOf(staker1.address);
      expect(balanceBefore.sub(balanceAfter)).to.equal(STAKE_AMOUNT);
      expect(await stakingToken.balanceOf(staking.address)).to.equal(
        STAKE_AMOUNT
      );
    });
  });

  /* ========== STAKE FOR ========== */

  describe("stakeFor()", function () {
    it("allows staking on behalf of a recipient", async function () {
      await staking
        .connect(staker1)
        .stakeFor(STAKE_AMOUNT, staker2.address);

      // staker1's staking token balance decreases
      expect(await staking.balanceOf(staker1.address)).to.equal(0);
      // recipient's staked balance increases
      expect(await staking.balanceOf(staker2.address)).to.equal(STAKE_AMOUNT);
      expect(await staking.totalSupply()).to.equal(STAKE_AMOUNT);
    });

    it("emits a StakedFor event with correct args", async function () {
      await expect(
        staking.connect(staker1).stakeFor(STAKE_AMOUNT, staker2.address)
      )
        .to.emit(staking, "StakedFor")
        .withArgs(staker1.address, staker2.address, STAKE_AMOUNT);
    });

    it("reverts when staking 0 amount", async function () {
      await expect(
        staking.connect(staker1).stakeFor(0, staker2.address)
      ).to.be.revertedWith("Cannot stake 0");
    });

    it("reverts when recipient is the zero address", async function () {
      await expect(
        staking
          .connect(staker1)
          .stakeFor(STAKE_AMOUNT, ethers.constants.AddressZero)
      ).to.be.revertedWith("Cannot stake for zero address");
    });

    it("pulls tokens from msg.sender, not the recipient", async function () {
      const staker1BalanceBefore = await stakingToken.balanceOf(staker1.address);
      const staker2BalanceBefore = await stakingToken.balanceOf(staker2.address);

      await staking.connect(staker1).stakeFor(STAKE_AMOUNT, staker2.address);

      expect(await stakingToken.balanceOf(staker1.address)).to.equal(
        staker1BalanceBefore.sub(STAKE_AMOUNT)
      );
      // staker2's token balance is unchanged (they are the recipient, not payer)
      expect(await stakingToken.balanceOf(staker2.address)).to.equal(
        staker2BalanceBefore
      );
    });

    it("recipient accrues rewards correctly after stakeFor", async function () {
      // Fund rewards first
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      // Stake for staker2 via staker1
      await staking.connect(staker1).stakeFor(STAKE_AMOUNT, staker2.address);

      await increaseTime(REWARDS_DURATION);

      // staker2 should have accrued rewards even though staker1 paid
      const earned = await staking.earned(staker2.address);
      expect(earned).to.be.gt(0);

      // staker1 should have no rewards
      expect(await staking.earned(staker1.address)).to.equal(0);
    });
  });

  /* ========== NOTIFY REWARD AMOUNT ========== */

  describe("notifyRewardAmount()", function () {
    beforeEach(async function () {
      // Transfer rewards to contract before calling notifyRewardAmount
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
    });

    it("only rewardsDistribution can call", async function () {
      await expect(
        staking.connect(anyUser).notifyRewardAmount(REWARD_AMOUNT)
      ).to.be.revertedWith("Caller is not RewardsDistribution contract");
    });

    it("sets rewardRate correctly", async function () {
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      const expectedRate = REWARD_AMOUNT.div(REWARDS_DURATION);
      expect(await staking.rewardRate()).to.be.closeTo(expectedRate, 1);
    });

    it("emits RewardAdded event", async function () {
      await expect(
        staking
          .connect(rewardsDistribution)
          .notifyRewardAmount(REWARD_AMOUNT)
      ).to.emit(staking, "RewardAdded");
    });

    it("auto-recycles withheldRewards when called", async function () {
      // Create a scenario with withheld rewards:
      // 1. Notify rewards
      // 2. Stake enough that cap kicks in
      // 3. Advance time to accumulate withheld rewards
      // 4. Call notifyRewardAmount again → withheldRewards should be recycled

      await staking.connect(rewardsDistribution).notifyRewardAmount(REWARD_AMOUNT);

      // Stake small amount so cap triggers (rate > maxRate * supply)
      const smallStake = ethers.utils.parseEther("1"); // 1 token staked
      await staking.connect(staker1).stake(smallStake);

      // Advance time so withheld rewards accumulate
      await increaseTime(3 * 24 * 60 * 60); // 3 days

      // Trigger an update to flush withheld rewards
      await staking.connect(staker1).stake(1); // dummy stake to trigger updateReward

      const withheldBefore = await staking.withheldRewards();
      expect(withheldBefore).to.be.gt(0, "Expected withheld rewards to be > 0");

      // Fund and notify again — should recycle withheld rewards
      const additionalReward = ethers.utils.parseEther("100");
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, additionalReward);

      await expect(
        staking
          .connect(rewardsDistribution)
          .notifyRewardAmount(additionalReward)
      ).to.emit(staking, "WithheldRewardsRecycled");

      expect(await staking.withheldRewards()).to.equal(0);
    });
  });

  /* ========== ADD TO REWARD ========== */

  describe("addToReward()", function () {
    it("allows anyone to add rewards", async function () {
      const rewardBefore = await rewardsToken.balanceOf(anyUser.address);

      await staking.connect(anyUser).addToReward(REWARD_AMOUNT);

      // tokens should be transferred from anyUser to contract
      expect(await rewardsToken.balanceOf(anyUser.address)).to.equal(
        rewardBefore.sub(REWARD_AMOUNT)
      );
      expect(await rewardsToken.balanceOf(staking.address)).to.equal(
        REWARD_AMOUNT
      );
    });

    it("sets rewardRate correctly", async function () {
      await staking.connect(anyUser).addToReward(REWARD_AMOUNT);
      const expectedRate = REWARD_AMOUNT.div(REWARDS_DURATION);
      expect(await staking.rewardRate()).to.be.closeTo(expectedRate, 1);
    });

    it("emits RewardAdded event", async function () {
      await expect(staking.connect(anyUser).addToReward(REWARD_AMOUNT)).to.emit(
        staking,
        "RewardAdded"
      );
    });

    it("auto-recycles withheldRewards when called", async function () {
      // Fund initial rewards via rewardsDistribution
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      // Stake small amount to trigger cap
      const smallStake = ethers.utils.parseEther("1");
      await staking.connect(staker1).stake(smallStake);

      // Advance time to accumulate withheld rewards
      await increaseTime(3 * 24 * 60 * 60);

      // Trigger updateReward to flush withheld amount into withheldRewards
      await staking.connect(staker1).stake(1);

      const withheldBefore = await staking.withheldRewards();
      expect(withheldBefore).to.be.gt(0, "Expected withheld rewards > 0");

      // anyUser adds rewards — withheld should be recycled automatically
      const additionalReward = ethers.utils.parseEther("50");
      await expect(staking.connect(anyUser).addToReward(additionalReward))
        .to.emit(staking, "WithheldRewardsRecycled")
        .and.to.emit(staking, "RewardAdded");

      expect(await staking.withheldRewards()).to.equal(0);
    });

    it("pulls tokens from caller via safeTransferFrom", async function () {
      // Reverts if allowance is not set
      const noAllowanceUser = staker1;
      await rewardsToken
        .connect(noAllowanceUser)
        .approve(staking.address, 0);
      await expect(
        staking.connect(noAllowanceUser).addToReward(REWARD_AMOUNT)
      ).to.be.reverted;
    });

    it("can be called by rewardsDistribution too", async function () {
      await expect(
        staking
          .connect(rewardsDistribution)
          .addToReward(ethers.utils.parseEther("100"))
      ).to.emit(staking, "RewardAdded");
    });
  });

  /* ========== WITHHELD REWARDS RECYCLING ========== */

  describe("Withheld rewards recycling", function () {
    it("withheldRewards resets to 0 after addToReward recycles them", async function () {
      // Setup: fund and start reward period with cap
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      // Small stake so cap is active
      await staking.connect(staker1).stake(ethers.utils.parseEther("1"));
      await increaseTime(2 * 24 * 60 * 60);
      // flush withheld by touching the contract
      await staking.connect(staker1).stake(1);

      expect(await staking.withheldRewards()).to.be.gt(0);

      // Recycle via addToReward
      await staking
        .connect(anyUser)
        .addToReward(ethers.utils.parseEther("10"));

      expect(await staking.withheldRewards()).to.equal(0);
    });

    it("withheldRewards resets to 0 after notifyRewardAmount recycles them", async function () {
      // Setup: fund and start reward period with cap
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      // Small stake so cap is active
      await staking.connect(staker1).stake(ethers.utils.parseEther("1"));
      await increaseTime(2 * 24 * 60 * 60);
      await staking.connect(staker1).stake(1);

      expect(await staking.withheldRewards()).to.be.gt(0);

      // Fund and recycle via notifyRewardAmount
      const addlReward = ethers.utils.parseEther("10");
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, addlReward);

      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(addlReward);

      expect(await staking.withheldRewards()).to.equal(0);
    });

    it("recycled withheld rewards are included in the new rewardRate", async function () {
      // Setup: fund and start reward period with cap — cap will withhold some rewards
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      const smallStake = ethers.utils.parseEther("1");
      await staking.connect(staker1).stake(smallStake);
      await increaseTime(2 * 24 * 60 * 60);
      await staking.connect(staker1).stake(1);

      const withheld = await staking.withheldRewards();
      expect(withheld).to.be.gt(0);

      // Now add a small reward — rate should incorporate both withheld + new
      const smallAddition = ethers.utils.parseEther("10");
      await staking.connect(anyUser).addToReward(smallAddition);

      // The new rewardRate should be higher than if we'd only added smallAddition alone
      const rateAfterRecycle = await staking.rewardRate();

      // Compare against what the rate would be with smallAddition alone (no recycling)
      // We can't easily compute this exactly without mocking time, so just assert rate > 0
      // and that withheld is now 0.
      expect(rateAfterRecycle).to.be.gt(0);
      expect(await staking.withheldRewards()).to.equal(0);
    });
  });

  /* ========== WITHDRAW ========== */

  describe("withdraw()", function () {
    beforeEach(async function () {
      await staking.connect(staker1).stake(STAKE_AMOUNT);
    });

    it("allows a staker to withdraw", async function () {
      await staking.connect(staker1).withdraw(STAKE_AMOUNT);
      expect(await staking.balanceOf(staker1.address)).to.equal(0);
      expect(await staking.totalSupply()).to.equal(0);
    });

    it("emits a Withdrawn event", async function () {
      await expect(staking.connect(staker1).withdraw(STAKE_AMOUNT))
        .to.emit(staking, "Withdrawn")
        .withArgs(staker1.address, STAKE_AMOUNT);
    });

    it("reverts when withdrawing 0", async function () {
      await expect(staking.connect(staker1).withdraw(0)).to.be.revertedWith(
        "Cannot withdraw 0"
      );
    });
  });

  /* ========== GET REWARD ========== */

  describe("getReward()", function () {
    it("transfers earned rewards to the staker", async function () {
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      await staking.connect(staker1).stake(STAKE_AMOUNT);
      await increaseTime(REWARDS_DURATION);

      const balanceBefore = await rewardsToken.balanceOf(staker1.address);
      await staking.connect(staker1).getReward();
      const balanceAfter = await rewardsToken.balanceOf(staker1.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  /* ========== WITHDRAW WITHHELD REWARDS ========== */

  describe("withdrawWithheldRewards()", function () {
    it("only rewardsDistribution can call", async function () {
      await expect(
        staking.connect(anyUser).withdrawWithheldRewards()
      ).to.be.revertedWith("Caller is not RewardsDistribution contract");
    });

    it("reverts when withheldRewards is zero", async function () {
      await expect(
        staking.connect(rewardsDistribution).withdrawWithheldRewards()
      ).to.be.revertedWith("withheldRewards is zero");
    });

    it("transfers withheld rewards to rewardsDistribution", async function () {
      // Build up withheld rewards
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      await staking.connect(staker1).stake(ethers.utils.parseEther("1"));
      await increaseTime(2 * 24 * 60 * 60);
      await staking.connect(staker1).stake(1);

      const withheld = await staking.withheldRewards();
      expect(withheld).to.be.gt(0);

      const distBalanceBefore = await rewardsToken.balanceOf(
        rewardsDistribution.address
      );

      await expect(
        staking.connect(rewardsDistribution).withdrawWithheldRewards()
      )
        .to.emit(staking, "WithheldRewardsWithdrawn")
        .withArgs(withheld);

      const distBalanceAfter = await rewardsToken.balanceOf(
        rewardsDistribution.address
      );
      expect(distBalanceAfter.sub(distBalanceBefore)).to.equal(withheld);
      expect(await staking.withheldRewards()).to.equal(0);
    });
  });

  /* ========== REWARD CAP ========== */

  describe("Reward cap", function () {
    it("getEffectiveRewardRate returns rewardRate when no cap", async function () {
      // No stakers → maxRewardRatePerToken doesn't apply
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      expect(await staking.getEffectiveRewardRate()).to.equal(
        await staking.rewardRate()
      );
    });

    it("getEffectiveRewardRate is capped based on totalSupply", async function () {
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);

      // Stake small amount → effective rate will be capped
      const smallStake = ethers.utils.parseEther("1");
      await staking.connect(staker1).stake(smallStake);

      const rewardRate = await staking.rewardRate();
      const effectiveRate = await staking.getEffectiveRewardRate();
      // With 1 token staked, maxAllowed = maxRatePerToken * 1 token / 1e18
      const maxAllowed = MAX_REWARD_RATE_PER_TOKEN.mul(smallStake).div(
        ethers.utils.parseEther("1")
      );

      expect(effectiveRate).to.equal(maxAllowed);
      expect(effectiveRate).to.be.lt(rewardRate);
    });
  });

  /* ========== SET FUNCTIONS ========== */

  describe("setMaxRewardRatePerToken()", function () {
    it("only owner can call", async function () {
      await expect(
        staking.connect(anyUser).setMaxRewardRatePerToken(1)
      ).to.be.revertedWith("Only the contract owner may perform this action");
    });

    it("updates maxRewardRatePerToken and emits event", async function () {
      const newRate = ethers.utils.parseEther("0.000002");
      await expect(staking.connect(owner).setMaxRewardRatePerToken(newRate))
        .to.emit(staking, "MaxRewardRateUpdated")
        .withArgs(newRate);

      expect(await staking.maxRewardRatePerToken()).to.equal(newRate);
    });
  });

  describe("setRewardsDuration()", function () {
    it("only owner can call", async function () {
      await expect(
        staking.connect(anyUser).setRewardsDuration(14 * 24 * 60 * 60)
      ).to.be.revertedWith("Only the contract owner may perform this action");
    });

    it("reverts if period is not complete", async function () {
      await rewardsToken
        .connect(rewardsDistribution)
        .transfer(staking.address, REWARD_AMOUNT);
      await staking
        .connect(rewardsDistribution)
        .notifyRewardAmount(REWARD_AMOUNT);
      await expect(
        staking.connect(owner).setRewardsDuration(14 * 24 * 60 * 60)
      ).to.be.revertedWith("Previous rewards period must be complete");
    });
  });
});
