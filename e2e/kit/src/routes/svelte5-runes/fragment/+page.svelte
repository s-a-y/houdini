<script lang="ts">
  import type { PageData } from './$houdini';
  import UserDetailsSvelte5 from './UserDetailsSvelte5.svelte';

  interface Props {
    data: PageData;
  }
  const { data }: Props = $props();
  const { Svelte5UsersList } = $derived(data);
</script>

<div>
  {#if $Svelte5UsersList.data}
    <ul>
      {#each $Svelte5UsersList.data.usersConnection.edges as edge}
          <li>
              <UserDetailsSvelte5 user={edge.node!} />
          </li>
      {/each}
    </ul>
  {/if}

  <div id="pageInfo">{JSON.stringify($Svelte5UsersList.pageInfo)}</div>
  <button id="next" onclick={()=> Svelte5UsersList.loadNextPage()}>load more</button>
</div>
